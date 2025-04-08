const cron = require('node-cron');
const { syncDiscogsInventory } = require('../services/inventoryService');
const prisma = require('../lib/prisma'); // Optional: May not be needed anymore

// Remove ownerUserId dependency
// const ownerUserId = process.env.OWNER_USER_ID;

// Function to start the scheduled job
const startInventorySyncJob = () => {
  // Remove ownerUserId check
  // if (!ownerUserId) { ... }

  console.log(`Scheduling inventory sync job.`);

  // Schedule to run daily at 3:00 AM (adjust cron string as needed)
  // See https://crontab.guru/ for help with cron strings
  cron.schedule('0 3 * * *', async () => {
    console.log('[Cron Job] Running scheduled Discogs inventory sync...');
    try {
      // Remove owner user verification logic
      // const ownerExists = await prisma.user.findUnique(...);

      // Call sync without userId
      const result = await syncDiscogsInventory(); // No argument
      if (result.success) {
        console.log(`[Cron Job] Inventory sync completed successfully. Synced: ${result.synced}, Errors: ${result.errors}`);
      } else {
        console.error(`[Cron Job] Inventory sync failed: ${result.message}`);
      }
    } catch (error) {
      console.error('[Cron Job] An unexpected error occurred during scheduled inventory sync:', error);
    }
  }, {
    scheduled: true,
    timezone: "Etc/UTC" // Set to your server's timezone or keep UTC
  });

  console.log('Inventory sync job scheduled to run daily at 3:00 AM UTC.');
};

module.exports = { startInventorySyncJob }; 