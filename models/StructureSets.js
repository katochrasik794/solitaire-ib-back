import { query } from '../config/database.js';

export class StructureSets {
  static async createTable() {
    // Create structure_sets table
    await query(`
      CREATE TABLE IF NOT EXISTS structure_sets (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL UNIQUE,
        stage INTEGER NOT NULL DEFAULT 1,
        description TEXT,
        status VARCHAR(50) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Create junction table
    await query(`
      CREATE TABLE IF NOT EXISTS structure_set_structures (
        id SERIAL PRIMARY KEY,
        structure_set_id INTEGER NOT NULL REFERENCES structure_sets(id) ON DELETE CASCADE,
        structure_name VARCHAR(100) NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(structure_set_id, structure_name)
      );
    `);

    // Create indexes
    await query(`CREATE INDEX IF NOT EXISTS idx_structure_sets_name ON structure_sets(name);`).catch(() => {});
    await query(`CREATE INDEX IF NOT EXISTS idx_structure_sets_stage ON structure_sets(stage);`).catch(() => {});
    await query(`CREATE INDEX IF NOT EXISTS idx_structure_sets_status ON structure_sets(status);`).catch(() => {});
    await query(`CREATE INDEX IF NOT EXISTS idx_structure_set_structures_set_id ON structure_set_structures(structure_set_id);`).catch(() => {});
    await query(`CREATE INDEX IF NOT EXISTS idx_structure_set_structures_name ON structure_set_structures(structure_name);`).catch(() => {});
  }

  static async getAll() {
    const result = await query(`
      SELECT 
        ss.*,
        COUNT(DISTINCT sss.structure_name) as structures_count
      FROM structure_sets ss
      LEFT JOIN structure_set_structures sss ON ss.id = sss.structure_set_id
      GROUP BY ss.id
      ORDER BY ss.stage ASC, ss.name ASC
    `);
    return result.rows || [];
  }

  static async getById(id) {
    const result = await query('SELECT * FROM structure_sets WHERE id = $1', [id]);
    return result.rows[0] || null;
  }

  static async create(setData) {
    const { name, stage = 1, description = '', status = 'active', structureNames = [] } = setData;

    // Insert structure set
    const setResult = await query(
      `INSERT INTO structure_sets (name, stage, description, status)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [name, stage, description, status]
    );

    const structureSet = setResult.rows[0];

    // Insert structure names
    if (structureNames.length > 0) {
      const values = structureNames.map((_, index) => {
        const baseIndex = index * 2;
        return `($${baseIndex + 1}, $${baseIndex + 2})`;
      }).join(', ');

      const params = structureNames.flatMap(name => [structureSet.id, name]);
      await query(
        `INSERT INTO structure_set_structures (structure_set_id, structure_name)
         VALUES ${values}
         ON CONFLICT (structure_set_id, structure_name) DO NOTHING`,
        params
      );
    }

    return structureSet;
  }

  static async update(id, setData) {
    const { name, stage, description, status, structureNames } = setData;

    // Update structure set
    const updateFields = [];
    const params = [];
    let paramIndex = 1;

    if (name !== undefined) {
      updateFields.push(`name = $${paramIndex++}`);
      params.push(name);
    }
    if (stage !== undefined) {
      updateFields.push(`stage = $${paramIndex++}`);
      params.push(stage);
    }
    if (description !== undefined) {
      updateFields.push(`description = $${paramIndex++}`);
      params.push(description);
    }
    if (status !== undefined) {
      updateFields.push(`status = $${paramIndex++}`);
      params.push(status);
    }

    if (updateFields.length === 0) {
      throw new Error('No fields to update');
    }

    updateFields.push(`updated_at = CURRENT_TIMESTAMP`);
    params.push(id);

    const result = await query(
      `UPDATE structure_sets 
       SET ${updateFields.join(', ')}
       WHERE id = $${paramIndex}
       RETURNING *`,
      params
    );

    // Update structure names if provided
    if (structureNames !== undefined) {
      // Delete existing links
      await query('DELETE FROM structure_set_structures WHERE structure_set_id = $1', [id]);

      // Insert new links
      if (structureNames.length > 0) {
        const values = structureNames.map((_, index) => {
          return `($1, $${index + 2})`;
        }).join(', ');

        const insertParams = [id, ...structureNames];
        await query(
          `INSERT INTO structure_set_structures (structure_set_id, structure_name)
           VALUES ${values}
           ON CONFLICT (structure_set_id, structure_name) DO NOTHING`,
          insertParams
        );
      }
    }

    return result.rows[0];
  }

  static async delete(id) {
    // Cascade delete will handle structure_set_structures
    const result = await query('DELETE FROM structure_sets WHERE id = $1 RETURNING *', [id]);
    return result.rows[0];
  }

  static async getStructuresBySetId(setId) {
    const result = await query(`
      SELECT structure_name
      FROM structure_set_structures
      WHERE structure_set_id = $1
      ORDER BY structure_name ASC
    `, [setId]);
    return result.rows.map(row => row.structure_name);
  }

  static async getStructuresWithDetails(setId) {
    // Get all commission structures that match the structure names in this set
    const result = await query(`
      SELECT DISTINCT
        gcs.id,
        gcs.group_id,
        gcs.structure_name,
        gcs.usd_per_lot,
        gcs.spread_share_percentage,
        gcs.level_order,
        gcs.min_trading_volume,
        gcs.max_trading_volume,
        gcs.min_active_clients,
        gcs.is_active,
        COALESCE(gm.dedicated_name, gcs.group_id) as group_name
      FROM structure_set_structures sss
      INNER JOIN group_commission_structures gcs ON gcs.structure_name = sss.structure_name
      LEFT JOIN group_management gm ON gm."group" = gcs.group_id
      WHERE sss.structure_set_id = $1
      ORDER BY gcs.level_order ASC, gcs.structure_name ASC, gcs.group_id ASC
    `, [setId]);
    return result.rows;
  }

  static async getAllAvailableStructures() {
    // Get all unique structure names with their details from all groups (including inactive)
    const result = await query(`
      SELECT 
        gcs.structure_name,
        gcs.level_order,
        gcs.group_id,
        gcs.usd_per_lot,
        gcs.spread_share_percentage,
        gcs.min_trading_volume,
        gcs.max_trading_volume,
        gcs.min_active_clients,
        gcs.is_active,
        COALESCE(gm.dedicated_name, gcs.group_id) as group_name
      FROM group_commission_structures gcs
      LEFT JOIN group_management gm ON gm."group" = gcs.group_id
      WHERE gcs.structure_name IS NOT NULL AND gcs.structure_name != ''
      ORDER BY gcs.level_order ASC, gcs.structure_name ASC, gcs.group_id ASC
    `);
    console.log(`[StructureSets] getAllAvailableStructures: Found ${result.rows.length} structures`);
    return result.rows;
  }
}

