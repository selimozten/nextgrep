#!/usr/bin/env python3
"""
Fine-tune a small model for NextGrep agentic code search.

Two-phase training:
  Phase 1: SFT (Supervised Fine-Tuning) on search traces
  Phase 2: GRPO (Group Relative Policy Optimization) with retrieval reward

Outputs a LoRA adapter that can be merged + quantized to GGUF for llama.cpp.

Requirements:
    pip install torch transformers trl peft datasets accelerate bitsandbytes

Usage:
    # Phase 1: SFT
    python finetune.py sft --data training/data/train.jsonl --model Qwen/Qwen2.5-Coder-3B-Instruct

    # Phase 2: GRPO (after SFT)
    python finetune.py grpo --data training/data/train.jsonl --model outputs/sft/final

    # Export to GGUF
    python finetune.py export --model outputs/grpo/final --quantize q4_k_m
"""

import argparse
import json
import sys
from pathlib import Path


def train_sft(args):
    """Phase 1: Supervised Fine-Tuning on search traces."""
    try:
        import torch
        from datasets import load_dataset
        from peft import LoraConfig, get_peft_model, TaskType
        from transformers import (
            AutoModelForCausalLM,
            AutoTokenizer,
            TrainingArguments,
        )
        from trl import SFTTrainer, SFTConfig
    except ImportError as e:
        print(f"Missing dependency: {e}")
        print("Install: pip install torch transformers trl peft datasets accelerate bitsandbytes")
        sys.exit(1)

    print(f"Loading model: {args.model}")
    tokenizer = AutoTokenizer.from_pretrained(args.model, trust_remote_code=True)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token

    model = AutoModelForCausalLM.from_pretrained(
        args.model,
        torch_dtype=torch.bfloat16,
        device_map="auto",
        trust_remote_code=True,
    )

    # LoRA config — small rank for a small model
    lora_config = LoraConfig(
        task_type=TaskType.CAUSAL_LM,
        r=16,
        lora_alpha=32,
        lora_dropout=0.05,
        target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"],
    )

    print(f"Loading data: {args.data}")
    dataset = load_dataset("json", data_files={"train": args.data, "validation": args.val})

    def format_messages(example):
        """Convert our training format to chat template."""
        messages = example["messages"]
        text = tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=False)
        return {"text": text}

    dataset = dataset.map(format_messages)

    output_dir = Path(args.output) / "sft"
    output_dir.mkdir(parents=True, exist_ok=True)

    training_args = SFTConfig(
        output_dir=str(output_dir),
        num_train_epochs=args.epochs,
        per_device_train_batch_size=args.batch_size,
        per_device_eval_batch_size=args.batch_size,
        gradient_accumulation_steps=args.grad_accum,
        learning_rate=2e-4,
        lr_scheduler_type="cosine",
        warmup_ratio=0.1,
        bf16=True,
        logging_steps=10,
        eval_strategy="steps",
        eval_steps=100,
        save_strategy="steps",
        save_steps=200,
        save_total_limit=3,
        max_seq_length=4096,
        dataset_text_field="text",
        packing=True,
        report_to="none",
    )

    trainer = SFTTrainer(
        model=model,
        args=training_args,
        train_dataset=dataset["train"],
        eval_dataset=dataset["validation"],
        peft_config=lora_config,
    )

    print("Starting SFT training...")
    trainer.train()

    final_path = output_dir / "final"
    trainer.save_model(str(final_path))
    tokenizer.save_pretrained(str(final_path))
    print(f"\nSFT model saved to {final_path}")


def train_grpo(args):
    """Phase 2: GRPO with retrieval reward function."""
    try:
        import torch
        from datasets import load_dataset
        from peft import LoraConfig, TaskType
        from transformers import AutoModelForCausalLM, AutoTokenizer
        from trl import GRPOTrainer, GRPOConfig
    except ImportError as e:
        print(f"Missing dependency: {e}")
        print("Install: pip install torch transformers trl peft datasets accelerate")
        sys.exit(1)

    print(f"Loading SFT model: {args.model}")
    tokenizer = AutoTokenizer.from_pretrained(args.model, trust_remote_code=True)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token

    model = AutoModelForCausalLM.from_pretrained(
        args.model,
        torch_dtype=torch.bfloat16,
        device_map="auto",
        trust_remote_code=True,
    )

    print(f"Loading data: {args.data}")
    dataset = load_dataset("json", data_files=args.data, split="train")

    def retrieval_reward(completions: list[str], metadata: list[dict]) -> list[float]:
        """
        Reward function: scores how well the model's search found the expected files.

        Rewards:
          +1.0  for each expected file found in the output
          +0.5  for partial matches (file mentioned but not in contexts JSON)
          -0.5  for outputting files that aren't relevant
          +0.2  bonus for valid JSON output
          +0.3  bonus for using <3 turns (efficiency)
        """
        rewards = []
        for completion, meta in zip(completions, metadata):
            expected_files = set(meta.get("expected_files", []))
            reward = 0.0

            # Check for valid JSON
            try:
                # Extract JSON from completion
                if "```json" in completion:
                    json_str = completion.split("```json")[1].split("```")[0]
                elif "```" in completion:
                    json_str = completion.split("```")[1].split("```")[0]
                else:
                    json_str = completion

                parsed = json.loads(json_str.strip())
                contexts = parsed.get("contexts", [])
                reward += 0.2  # Valid JSON bonus

                found_files = {ctx.get("file", "") for ctx in contexts}

                # Reward for finding expected files
                for ef in expected_files:
                    if ef in found_files:
                        reward += 1.0
                    elif any(ef in f for f in found_files):
                        reward += 0.5

                # Penalty for irrelevant files
                irrelevant = found_files - expected_files
                reward -= 0.5 * len(irrelevant)

            except (json.JSONDecodeError, IndexError):
                reward -= 0.5  # Invalid output penalty

            # Efficiency bonus: fewer tool calls = better
            tool_call_count = completion.count('"name":')
            if tool_call_count <= 6:
                reward += 0.3

            rewards.append(max(reward, -1.0))  # Floor at -1

        return rewards

    # Prepare prompts (just the query, model generates the full trace)
    def prepare_prompt(example):
        messages = example["messages"]
        # Only keep system + user message as the prompt
        prompt_messages = [m for m in messages if m["role"] in ("system", "user")]
        prompt = tokenizer.apply_chat_template(prompt_messages, tokenize=False, add_generation_prompt=True)
        return {
            "prompt": prompt,
            "metadata": example.get("metadata", {}),
        }

    dataset = dataset.map(prepare_prompt)

    output_dir = Path(args.output) / "grpo"
    output_dir.mkdir(parents=True, exist_ok=True)

    grpo_config = GRPOConfig(
        output_dir=str(output_dir),
        num_train_epochs=args.epochs,
        per_device_train_batch_size=1,
        gradient_accumulation_steps=args.grad_accum,
        learning_rate=5e-6,
        lr_scheduler_type="cosine",
        warmup_ratio=0.1,
        bf16=True,
        logging_steps=10,
        save_strategy="steps",
        save_steps=100,
        save_total_limit=2,
        max_completion_length=2048,
        num_generations=4,  # Generate 4 completions per prompt for GRPO
        report_to="none",
    )

    trainer = GRPOTrainer(
        model=model,
        args=grpo_config,
        train_dataset=dataset,
        reward_funcs=retrieval_reward,
    )

    print("Starting GRPO training...")
    trainer.train()

    final_path = output_dir / "final"
    trainer.save_model(str(final_path))
    tokenizer.save_pretrained(str(final_path))
    print(f"\nGRPO model saved to {final_path}")


def export_gguf(args):
    """Export fine-tuned model to GGUF format for llama.cpp."""
    print("Exporting to GGUF...")
    print()
    print("Steps to export your fine-tuned model to GGUF:")
    print()
    print(f"1. Merge LoRA adapter (if not already merged):")
    print(f"   python -m peft.merge_and_unload {args.model} --output {args.model}-merged")
    print()
    print(f"2. Convert to GGUF using llama.cpp's convert script:")
    print(f"   python llama.cpp/convert_hf_to_gguf.py {args.model}-merged --outfile nextgrep-search.gguf")
    print()
    print(f"3. Quantize (recommended: Q4_K_M for balance of speed/quality):")
    print(f"   llama.cpp/llama-quantize nextgrep-search.gguf nextgrep-search-{args.quantize}.gguf {args.quantize}")
    print()
    print(f"4. Use with NextGrep:")
    print(f"   nextgrep local 'your query' --model ./nextgrep-search-{args.quantize}.gguf")
    print()

    # Also write a convenience script
    script_path = Path(args.model).parent / "export_gguf.sh"
    script = f"""#!/bin/bash
set -e

MODEL_DIR="{args.model}"
LLAMA_CPP="${{LLAMA_CPP_DIR:-$HOME/llama.cpp}}"
QUANT="{args.quantize}"

echo "Merging LoRA adapter..."
python -c "
from peft import AutoPeftModelForCausalLM
from transformers import AutoTokenizer
model = AutoPeftModelForCausalLM.from_pretrained('$MODEL_DIR')
merged = model.merge_and_unload()
merged.save_pretrained('$MODEL_DIR-merged')
AutoTokenizer.from_pretrained('$MODEL_DIR').save_pretrained('$MODEL_DIR-merged')
"

echo "Converting to GGUF..."
python "$LLAMA_CPP/convert_hf_to_gguf.py" "$MODEL_DIR-merged" \\
    --outfile "nextgrep-search.gguf"

echo "Quantizing to $QUANT..."
"$LLAMA_CPP/llama-quantize" "nextgrep-search.gguf" \\
    "nextgrep-search-$QUANT.gguf" "$QUANT"

echo ""
echo "Done! Use with:"
echo "  nextgrep local 'your query' --model ./nextgrep-search-$QUANT.gguf"
"""
    script_path.write_text(script)
    script_path.chmod(0o755)
    print(f"Convenience script written to: {script_path}")


def main():
    parser = argparse.ArgumentParser(description="Fine-tune NextGrep code search model")
    subparsers = parser.add_subparsers(dest="command", required=True)

    # SFT
    sft_parser = subparsers.add_parser("sft", help="Phase 1: Supervised Fine-Tuning")
    sft_parser.add_argument("--model", default="Qwen/Qwen2.5-Coder-3B-Instruct")
    sft_parser.add_argument("--data", default="training/data/train.jsonl")
    sft_parser.add_argument("--val", default="training/data/val.jsonl")
    sft_parser.add_argument("--output", default="training/outputs")
    sft_parser.add_argument("--epochs", type=int, default=3)
    sft_parser.add_argument("--batch-size", type=int, default=2)
    sft_parser.add_argument("--grad-accum", type=int, default=8)

    # GRPO
    grpo_parser = subparsers.add_parser("grpo", help="Phase 2: GRPO reinforcement learning")
    grpo_parser.add_argument("--model", default="training/outputs/sft/final")
    grpo_parser.add_argument("--data", default="training/data/train.jsonl")
    grpo_parser.add_argument("--output", default="training/outputs")
    grpo_parser.add_argument("--epochs", type=int, default=1)
    grpo_parser.add_argument("--grad-accum", type=int, default=16)

    # Export
    export_parser = subparsers.add_parser("export", help="Export to GGUF for llama.cpp")
    export_parser.add_argument("--model", default="training/outputs/grpo/final")
    export_parser.add_argument("--quantize", default="q4_k_m", choices=["q4_k_m", "q5_k_m", "q8_0", "f16"])

    args = parser.parse_args()

    if args.command == "sft":
        train_sft(args)
    elif args.command == "grpo":
        train_grpo(args)
    elif args.command == "export":
        export_gguf(args)


if __name__ == "__main__":
    main()
