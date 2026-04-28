from crewai import Agent, Task, Crew, Process
from shop_agents.llm import get_llm
from shop_agents.tools.browser import ProductScraperTool, PurchaseTool

def create_shopper(persona_description: str):
    """Factory for creating a shopper agent based on a persona."""
    llm = get_llm()
    
    return Agent(
        role='Autonomous Shopper',
        goal=f'Find and buy a product from the shop that fits your persona: {persona_description}',
        backstory=(
            f"You are a sophisticated AI agent with a specific shopping personality: {persona_description}. "
            "You browse the online store, evaluate items based on your tastes, and complete the purchase process "
            "using your available tools. You are decisive and move efficiently from selection to checkout."
        ),
        tools=[ProductScraperTool(), PurchaseTool()],
        llm=llm,
        verbose=True
    )

def run_shopping_session(persona_description: str):
    """Orchestrates a single shopping run."""
    shopper = create_shopper(persona_description)
    
    task = Task(
        description=(
            "1. Use the product_scraper to see what's available.\n"
            "2. Choose one product that best matches your persona.\n"
            "3. Use the purchase_tool to buy the selected product."
        ),
        expected_output="A confirmation of the purchase, including the product name and the final result from the tool.",
        agent=shopper
    )
    
    crew = Crew(
        agents=[shopper],
        tasks=[task],
        process=Process.sequential
    )
    
    return crew.kickoff()
