import os
from google import genai
from dotenv import load_dotenv

# Load from .env if present
load_dotenv()

def list_available_models():
    """Lists Gemini models that support content generation."""
    api_key = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")
    
    if not api_key:
        print("Error: Neither GEMINI_API_KEY nor GOOGLE_API_KEY found in environment.")
        return

    client = genai.Client(api_key=api_key)
    
    print(f"Checking models for API key ending in ...{api_key[-4:]}")
    print("-" * 50)
    
    try:
        # List models
        for model in client.models.list():
            actions = getattr(model, 'supported_actions', [])
            # Some models might use generateContent, others might be legacy or 
            # have no actions listed but still work.
            if "generateContent" in actions or "generate_content" in actions or not actions:
                print(f"Model: {model.name}")
    except Exception as e:
        print(f"Failed to list models: {e}")

if __name__ == "__main__":
    list_available_models()
