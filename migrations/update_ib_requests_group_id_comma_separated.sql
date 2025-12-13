-- Migration: Update ib_requests table to have comma-separated group_ids
-- This migration updates existing entries to have comma-separated group_ids
-- based on their ib_group_assignments

-- Step 1: Update ib_requests with comma-separated group_ids from ib_group_assignments
UPDATE ib_requests ir
SET group_id = (
  SELECT string_agg(DISTINCT iga.group_id, ',' ORDER BY iga.group_id)
  FROM ib_group_assignments iga
  WHERE iga.ib_request_id = ir.id
  AND iga.group_id IS NOT NULL
  AND iga.group_id != ''
)
WHERE ir.status = 'approved'
AND EXISTS (
  SELECT 1 
  FROM ib_group_assignments iga 
  WHERE iga.ib_request_id = ir.id
  GROUP BY iga.ib_request_id
  HAVING COUNT(DISTINCT iga.group_id) > 1
);

-- Step 2: For IBs with only one group assignment, ensure group_id is set
UPDATE ib_requests ir
SET group_id = (
  SELECT iga.group_id
  FROM ib_group_assignments iga
  WHERE iga.ib_request_id = ir.id
  AND iga.group_id IS NOT NULL
  AND iga.group_id != ''
  LIMIT 1
)
WHERE ir.status = 'approved'
AND ir.group_id IS NULL
AND EXISTS (
  SELECT 1 
  FROM ib_group_assignments iga 
  WHERE iga.ib_request_id = ir.id
  AND iga.group_id IS NOT NULL
  AND iga.group_id != ''
);

-- Verification query (optional - run this to check results)
-- SELECT 
--   ir.id,
--   ir.email,
--   ir.group_id as ib_requests_group_id,
--   COUNT(DISTINCT iga.group_id) as assignment_count,
--   string_agg(DISTINCT iga.group_id, ',' ORDER BY iga.group_id) as assignments_group_ids
-- FROM ib_requests ir
-- LEFT JOIN ib_group_assignments iga ON iga.ib_request_id = ir.id
-- WHERE ir.status = 'approved'
-- GROUP BY ir.id, ir.email, ir.group_id
-- ORDER BY ir.id;

-- Migration completed successfully
-- You can verify the results by running the verification query above (uncomment it)

