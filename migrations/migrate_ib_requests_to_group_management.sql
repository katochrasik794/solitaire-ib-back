-- Migration: Ensure all ib_requests.group_id entries map correctly to group_management table
-- This migration verifies and updates ib_requests entries to ensure they link correctly to group_management

-- Step 1: Check for ib_requests with group_ids that don't exist in group_management
-- (This is informational - we'll log these but not fail the migration)

-- Step 2: For approved IBs, ensure their group_ids exist in group_management
-- If a group_id in ib_requests doesn't exist in group_management, we'll create a placeholder entry
-- This ensures referential integrity

DO $$
DECLARE
    missing_group RECORD;
    created_count INTEGER := 0;
BEGIN
    -- Find group_ids in ib_requests that don't exist in group_management
    FOR missing_group IN
        SELECT DISTINCT 
            unnest(string_to_array(ir.group_id, ',')) as group_id
        FROM ib_requests ir
        WHERE ir.status = 'approved' 
          AND ir.group_id IS NOT NULL 
          AND ir.group_id != ''
          AND NOT EXISTS (
              SELECT 1 FROM group_management gm 
              WHERE gm."group" = unnest(string_to_array(ir.group_id, ','))
          )
    LOOP
        -- Create placeholder entry in group_management if it doesn't exist
        INSERT INTO group_management ("group", dedicated_name)
        VALUES (
            missing_group.group_id,
            missing_group.group_id -- Use group_id as dedicated_name if no dedicated name exists
        )
        ON CONFLICT ("group") DO NOTHING;
        
        created_count := created_count + 1;
    END LOOP;
    
    RAISE NOTICE 'Created % placeholder group entries in group_management', created_count;
END $$;

-- Step 3: Verify all approved IBs have valid group mappings
-- This query will show any remaining issues (for manual review)
SELECT 
    ir.id as ib_request_id,
    ir.email,
    ir.group_id,
    ir.status,
    CASE 
        WHEN ir.group_id IS NULL OR ir.group_id = '' THEN 'No group_id set'
        WHEN NOT EXISTS (
            SELECT 1 FROM group_management gm 
            WHERE gm."group" = ANY(string_to_array(ir.group_id, ','))
        ) THEN 'Group_id not found in group_management'
        ELSE 'OK'
    END as mapping_status
FROM ib_requests ir
WHERE ir.status = 'approved'
ORDER BY ir.id;

