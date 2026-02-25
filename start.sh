#!/bin/bash

ENV_FILE=".env"

export_env() {
    if [ ! -f "$ENV_FILE" ]; then
      echo "Error: Environment file not found" 1>&2 && exit 1
    fi
    while IFS= read -r line; do
      if [[ "$line" =~ ^# || -z "$line" ]]; then
        continue  
      fi
      export "$line"  
    done < "$ENV_FILE"
}

run_flowise() {
    pnpm start
}

main() {
    export_env
    run_flowise
}

main
