import os
import time
import json
import re
from google import genai
from dotenv import load_dotenv

# Load from .env if present
load_dotenv()

def parse_quota_error(error_msg):
    """
    Parses the detailed JSON error from Gemini 429 responses.
    """
    try:
        # Extract the JSON part from the error string
        # Typically looks like: 429 RESOURCE_EXHAUSTED. {'error': ...}
        match = re.search(r"({.*})", error_msg, re.DOTALL)
        if not match:
            return "Could not parse detailed quota info."
        
        # Replace single quotes with double quotes for valid JSON
        # This is a bit fragile but often works for these repr-style strings
        json_str = match.group(1).replace("'", '"')
        data = json.loads(json_str)
        
        violations = data.get('error', {}).get('details', [])
        quota_details = []
        
        for detail in violations:
            if detail.get('@type') == 'type.googleapis.com/google.rpc.QuotaFailure':
                for v in detail.get('violations', []):
                    metric = v.get('quotaMetric', 'Unknown Metric')
                    quota_id = v.get('quotaId', 'Unknown ID')
                    # Clean up the metric name for readability
                    metric_short = metric.split('/')[-1]
                    quota_details.append(f"  - {metric_short} ({quota_id})")
            
            if detail.get('@type') == 'type.googleapis.com/google.rpc.RetryInfo':
                delay = detail.get('retryDelay', 'unknown')
                quota_details.append(f"  - Retry after: {delay}")

        return "\n".join(quota_details) if quota_details else "No specific violations listed."
    except Exception as e:
        return f"Error parsing details: {e}"

def check_model_quota(client, model_name):
    """
    Attempts to check the quota for a specific model by making a minimal request.
    """
    try:
        # A very small request to trigger potential 429 if quota is already zero
        client.models.generate_content(
            model=model_name,
            contents="hi"
        )
        return "✅ AVAILABLE (Request successful)"
    except Exception as e:
        error_str = str(e)
        if "429" in error_str:
            details = parse_quota_error(error_str)
            return f"❌ EXHAUSTED (429)\n{details}"
        elif "404" in error_str:
            return "❓ NOT FOUND (404) - Check if this model is available for this API version/region."
        return f"⚠️ ERROR: {error_str}"

def list_and_check_quotas():
    api_key = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")
    
    if not api_key:
        print("Error: Neither GEMINI_API_KEY nor GOOGLE_API_KEY found in environment.")
        return

    client = genai.Client(api_key=api_key)
    
    # Dynamically get models first
    print("Fetching available models...")
    try:
        available_models = []
        for model in client.models.list():
            actions = getattr(model, 'supported_actions', [])
            if "generateContent" in actions or "generate_content" in actions or not actions:
                available_models.append(model.name)
    except Exception as e:
        print(f"Failed to list models: {e}")
        return

    print(f"\nAnalyzing quotas for {len(available_models)} models (API key ending in ...{api_key[-4:]})")
    print("=" * 80)
    
    # Sort models to make it easier to read
    available_models.sort()

    for model_id in available_models:
        # Skip some obviously non-text models if any
        if any(x in model_id for x in ['embedding', 'aqa', 'imagen', 'veo']):
            continue

        status = check_model_quota(client, model_id)
        print(f"Model: {model_id}\nStatus: {status}")
        print("-" * 80)
        # Small sleep to be polite and avoid self-triggering 429s on the check script
        time.sleep(0.5)

if __name__ == "__main__":
    list_and_check_quotas()
