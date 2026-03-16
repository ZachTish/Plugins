#!/bin/bash
# Fix import paths in copied files

# Fix logger imports (moved from root to root, no change needed in most cases)
# But services need to go up more levels

find src/services -name "*.ts" -type f -exec sed -i '' 's|import \* as logger from "\.\./logger"|import * as logger from "../../logger"|g' {} \;

# Fix utils imports in services
find src/services -name "*.ts" -type f -exec sed -i '' 's|from "\.\./utils"|from "../../utils"|g' {} \;

# Fix types imports in services
find src/services -name "*.ts" -type f -exec sed -i '' 's|from "\.\./types"|from "../../types"|g' {} \;

# Fix types imports in modals
find src/modals -name "*.ts" -type f -exec sed -i '' 's|from "\.\./types"|from "../types"|g' {} \;

# Fix types imports in features
find src/features -name "*.ts" -type f -exec sed -i '' 's|from "\.\./types"|from "../../types"|g' {} \;

echo "Import paths fixed!"
