import { GroupCommissionStructures } from './models/GroupCommissionStructures.js';
import { GroupManagement } from './models/GroupManagement.js';
import { IBAdmin } from './models/IBAdmin.js';
import { IBClientLinking } from './models/IBClientLinking.js';
import { IBCommission } from './models/IBCommission.js';
import { IBGroupAssignment } from './models/IBGroupAssignment.js';
import { IBReferral } from './models/IBReferral.js';
import { IBRequest } from './models/IBRequest.js';
import { IBRewardClaim } from './models/IBRewardClaim.js';
import { IBTradeHistory } from './models/IBTradeHistory.js';
import { IBWithdrawal } from './models/IBWithdrawal.js';
import { Symbols } from './models/Symbols.js';
import { SymbolsWithCategories } from './models/SymbolsWithCategories.js';

async function initDB() {
    console.log('Initializing IB Database Tables...');

    try {
        // Order matters due to foreign keys
        console.log('Creating IBRequest...');
        if (IBRequest.createTable) await IBRequest.createTable();

        console.log('Creating IBAdmin...');
        if (IBAdmin.createTable) await IBAdmin.createTable();

        console.log('Creating IBGroupAssignment...');
        if (IBGroupAssignment.createTable) await IBGroupAssignment.createTable();

        console.log('Creating GroupManagement...');
        if (GroupManagement.createTable) await GroupManagement.createTable();

        console.log('Creating GroupCommissionStructures...');
        if (GroupCommissionStructures.createTable) await GroupCommissionStructures.createTable();

        console.log('Creating IBReferral...');
        if (IBReferral.createTable) await IBReferral.createTable();

        console.log('Creating IBClientLinking...');
        if (IBClientLinking.createTable) await IBClientLinking.createTable();

        console.log('Creating IBCommission...');
        if (IBCommission.createTable) await IBCommission.createTable();

        console.log('Creating IBRewardClaim...');
        if (IBRewardClaim.createTable) await IBRewardClaim.createTable();

        console.log('Creating IBWithdrawal...');
        if (IBWithdrawal.createTable) await IBWithdrawal.createTable();

        console.log('Creating IBTradeHistory...');
        if (IBTradeHistory.createTable) await IBTradeHistory.createTable();

        console.log('Creating Symbols...');
        if (Symbols.createTable) await Symbols.createTable();

        console.log('Creating SymbolsWithCategories...');
        if (SymbolsWithCategories.createTable) await SymbolsWithCategories.createTable();

        console.log('Database initialization completed.');
        process.exit(0);
    } catch (error) {
        console.error('Database initialization failed:', error);
        process.exit(1);
    }
}

initDB();
