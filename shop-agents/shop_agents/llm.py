import os
from shop_agents.config import settings

def get_llm():
    """Returns the configured LLM for CrewAI."""
    if settings.llm_provider == "gemini":
        if not settings.google_api_key:
            raise ValueError(
                "GOOGLE_API_KEY is missing. Please run with 'doppler run' or set it in your environment."
            )
        
        os.environ["GEMINI_API_KEY"] = settings.google_api_key
        os.environ["GOOGLE_API_KEY"] = settings.google_api_key
        
        # When using crewai[google-genai], passing just the model name 
        # or gemini/model_name is preferred. 
        return f"gemini/{settings.gemini_model}"
    
    elif settings.llm_provider == "llama":
        if not settings.llama_api_key:
            raise ValueError(
                "LLAMA_API_KEY is missing. Please run with 'doppler run' or set it in your environment."
            )
            
        os.environ["OPENAI_API_KEY"] = settings.llama_api_key
        os.environ["OPENAI_API_BASE"] = "https://api.llama.com/v1"
        return f"openai/{settings.llama_model}"
    
    raise ValueError(f"Unsupported LLM provider: {settings.llm_provider}")
