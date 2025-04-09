import { syncService } from '../services/syncService';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

// Parse command line arguments
const args = process.argv.slice(2);
const syncType = args[0] || 'delta';  // default to delta if not specified

async function main() {
  console.log(`Starting ${syncType} sync process...`);
  
  try {
    if (syncType === 'initial') {
      console.log('Running INITIAL sync - this will delete and recreate all records!');
      console.log('Please wait, this may take several minutes...');
      
      const result = await syncService.performInitialSync();
      console.log(`Initial sync completed successfully. Created ${result.count} records.`);
    } else if (syncType === 'delta') {
      console.log('Running DELTA sync - this will update existing records and add new ones.');
      console.log('Please wait, this may take several minutes...');
      
      const result = await syncService.performDeltaSync();
      console.log(`Delta sync completed successfully.`);
      console.log(`Created: ${result.created}, Updated: ${result.updated}, Deleted: ${result.deleted}`);
    } else {
      console.error(`Unknown sync type: ${syncType}. Valid options are 'initial' or 'delta'.`);
      process.exit(1);
    }
  } catch (error) {
    console.error('Error during sync process:', error);
    process.exit(1);
  } finally {
    // Exit the process
    console.log('Sync process finished. Exiting...');
    process.exit(0);
  }
}

// Run the main function
main(); 