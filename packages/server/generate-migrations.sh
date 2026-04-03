#!/bin/bash

# Ensure a migration name is passed as an argument
if [ -z "$1" ]; then
  echo "Error: Migration name required."
  echo "Usage: ./generate-migrations.sh <MigrationName>"
  exit 1
fi

MIGRATION_NAME=$1
DIALECTS=("mariadb" "mysql" "postgres" "sqlite")

echo "Initiating generation for: ${DIALECTS[*]}"

for DIALECT in "${DIALECTS[@]}"; do
  echo "--- Processing: $DIALECT ---"

  # Inject the environment variable and output to the dialect-specific folder
  DATABASE_TYPE=$DIALECT pnpm typeorm migration:generate -d ./src/utils/typeormDataSource.ts ./src/database/migrations/$DIALECT/$MIGRATION_NAME

  if [ $? -eq 0 ]; then
    echo "✅ Completed: $DIALECT"
  else
    echo "❌ Failed: $DIALECT"
    # Exit early on failure to prevent partial generation states
    # exit 1
  fi
done

echo "Migration batch generation complete."
