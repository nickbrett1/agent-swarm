#!/usr/bin/env python3
import json
import os
import sys

def check_mcp_config():
    # File path relative to this script's directory
    config_path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), '.agents', 'mcp_config.json')
    if not os.path.exists(config_path):
        return True

    try:
        with open(config_path, 'r') as f:
            config = json.load(f)
    except Exception as e:
        print(f"Error reading {config_path}: {e}", file=sys.stderr)
        return False

    has_errors = False
    servers = config.get('mcpServers', {})
    for server_name, server_config in servers.items():
        env = server_config.get('env', {})
        for key, value in env.items():
            key_upper = key.upper()
            if any(term in key_upper for term in ['TOKEN', 'KEY', 'SECRET', 'PASSWORD']):
                if isinstance(value, str) and not value.startswith('$'):
                    print(f"Error: Raw secret detected in mcp_config.json under {server_name}.env.{key} = '{value}'. "
                          f"Please use environment variable reference (e.g. '$VARIABLE_NAME') instead.", file=sys.stderr)
                    has_errors = True

    return not has_errors

if __name__ == '__main__':
    if not check_mcp_config():
        sys.exit(1)
    print("Secrets check passed successfully.")
    sys.exit(0)
