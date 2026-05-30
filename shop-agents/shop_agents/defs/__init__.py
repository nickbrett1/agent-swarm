from dagster import asset, Config, Definitions, define_asset_job, Output, MetadataValue
from shop_agents.agents.shopper import run_shopping_session
from shop_agents.config import settings
import time
import litellm
import os

class ShopperConfig(Config):
    persona: str = "A cautious buyer looking for a good deal on tech items."
    gemini_model: str = "gemini-2.5-flash-lite" # Default to cheapest

@asset
def shopping_result(config: ShopperConfig):
    """Executes a shopping session and captures metrics for model evaluation."""
    # Override settings for this specific run
    settings.gemini_model = config.gemini_model
    
    start_time = time.time()
    crew_output = run_shopping_session(config.persona)
    end_time = time.time()
    
    latency = end_time - start_time
    usage = crew_output.token_usage if hasattr(crew_output, 'token_usage') else None
    
    # Calculate cost
    cost = 0.0
    if usage:
        try:
            cost = litellm.completion_cost(
                model=f"gemini/{config.gemini_model}",
                prompt_tokens=usage.prompt_tokens,
                completion_tokens=usage.completion_tokens
            )
        except Exception:
            # Fallback based on your pricing table
            input_rate = 0.05 if "lite" in config.gemini_model else 0.15
            output_rate = 0.20 if "lite" in config.gemini_model else 1.25
            cost = (usage.prompt_tokens * input_rate / 1_000_000) + (usage.completion_tokens * output_rate / 1_000_000)
    
    # Determine if it was a "Clean Success" or a "Struggle"
    # We look for various success markers in the agent final answer
    raw_output = str(crew_output.raw)
    success_keywords = ["Successfully processed", "Purchase complete", "Successfully purchased", "Transaction confirmation"]
    success = any(kw in raw_output for kw in success_keywords) or "checkout.stripe.com" in raw_output
    
    metadata = {
        "eval_model": config.gemini_model,
        "eval_latency": MetadataValue.float(latency),
        "eval_cost_usd": MetadataValue.float(float(cost)),
        "eval_tokens_total": MetadataValue.int(usage.total_tokens if usage else 0),
        "eval_requests": MetadataValue.int(usage.successful_requests if usage else 0),
        "eval_status": "PASS" if success else "FAIL",
        "eval_persona": config.gemini_model,
        "raw_log": MetadataValue.text(str(crew_output.raw))
    }
    
    return Output(
        value=str(crew_output.raw),
        metadata=metadata
    )

shop_agent_job = define_asset_job(
    name="shop_agent_job",
    selection="shopping_result"
)

defs = Definitions(
    assets=[shopping_result],
    jobs=[shop_agent_job]
)

