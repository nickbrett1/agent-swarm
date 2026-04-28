import os
from litellm import completion
from shop_agents.config import settings

def get_llm():
    """Returns the configured LLM for CrewAI."""
    if settings.llm_provider == "gemini":
        os.environ["GEMINI_API_KEY"] = settings.google_api_key or ""
        return f"gemini/{settings.gemini_model}"
    elif settings.llm_provider == "llama":
        os.environ["OPENAI_API_KEY"] = settings.llama_api_key or "" # Meta Llama API is OpenAI-compatible
        os.environ["OPENAI_API_BASE"] = "https://api.llama.com/v1" # Target Meta Llama API endpoint
        return f"openai/{settings.llama_model}"
    
    raise ValueError(f"Unsupported LLM provider: {settings.llm_provider}")
