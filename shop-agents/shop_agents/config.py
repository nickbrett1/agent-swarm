from pydantic_settings import BaseSettings, SettingsConfigDict
from typing import Literal

class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file_encoding='utf-8')

    # LLM Settings
    llm_provider: Literal["gemini", "llama"] = "gemini"
    gemini_model: str = "gemini/gemini-1.5-flash"
    llama_model: str = "openai/llama3" # Example for Meta Llama API format
    
    # API Keys (Loaded via Doppler)
    google_api_key: str | None = None
    llama_api_key: str | None = None
    
    # Target Configuration
    shop_url: str = "https://fintechnick.com/shop"
    
    # Stripe Test Credentials
    stripe_test_card: str = "4242 4242 4242 4242"
    stripe_test_expiry: str = "12/26"
    stripe_test_cvc: str = "123"

settings = Settings()
