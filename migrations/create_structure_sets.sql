-- Create structure_sets table
CREATE TABLE IF NOT EXISTS structure_sets (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL UNIQUE,
  stage INTEGER NOT NULL DEFAULT 1,
  description TEXT,
  status VARCHAR(50) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Create junction table to link structure sets to commission structures
-- This links by structure_name so all structures with the same name from different groups are included
CREATE TABLE IF NOT EXISTS structure_set_structures (
  id SERIAL PRIMARY KEY,
  structure_set_id INTEGER NOT NULL REFERENCES structure_sets(id) ON DELETE CASCADE,
  structure_name VARCHAR(100) NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(structure_set_id, structure_name)
);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_structure_sets_name ON structure_sets(name);
CREATE INDEX IF NOT EXISTS idx_structure_sets_stage ON structure_sets(stage);
CREATE INDEX IF NOT EXISTS idx_structure_sets_status ON structure_sets(status);
CREATE INDEX IF NOT EXISTS idx_structure_set_structures_set_id ON structure_set_structures(structure_set_id);
CREATE INDEX IF NOT EXISTS idx_structure_set_structures_name ON structure_set_structures(structure_name);

