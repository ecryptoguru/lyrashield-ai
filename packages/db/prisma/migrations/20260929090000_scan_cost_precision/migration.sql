ALTER TABLE "Scan"
  ALTER COLUMN "providerCostUsd" TYPE DECIMAL(19, 10)
    USING "providerCostUsd"::DECIMAL(19, 10),
  ALTER COLUMN "billedCostUsd" TYPE DECIMAL(19, 10)
    USING "billedCostUsd"::DECIMAL(19, 10);
