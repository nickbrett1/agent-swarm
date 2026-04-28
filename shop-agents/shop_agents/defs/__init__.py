from dagster import asset, Config, Definitions, define_asset_job
from shop_agents.agents.shopper import run_shopping_session

class ShopperConfig(Config):
    persona: str = "A cautious buyer looking for a good deal on tech items."

@asset
def shopping_result(config: ShopperConfig):
    """Executes a shopping session and returns the result."""
    result = run_shopping_session(config.persona)
    return result

shop_agent_job = define_asset_job(
    name="shop_agent_job",
    selection="shopping_result"
)

defs = Definitions(
    assets=[shopping_result],
    jobs=[shop_agent_job]
)

