require('dotenv').config();
const { getInventoryStats } = require('./src/services/inventoryService');

async function checkInventory() {
  console.log('Checking Discogs and local inventory statistics...');
  
  try {
    const stats = await getInventoryStats();
    console.log('\nInventory Statistics:');
    console.log('====================');
    
    console.log('\nLOCAL DATABASE:');
    console.log(`- Total FOR_SALE records: ${stats.local.total}`);
    console.log(`- Records with discogsListingId: ${stats.local.withListingId}`);
    console.log(`- Records without discogsListingId: ${stats.local.withoutListingId}`);
    
    console.log('\nDISCOGS API:');
    console.log(`- Total items reported by API: ${stats.discogs.reported}`);
    console.log(`- Total pages: ${stats.discogs.pages}`);
    console.log(`- Status distribution in sample: ${JSON.stringify(stats.discogs.statusDistribution)}`);
    console.log(`- Percentage of "Draft" (For Sale) items: ${stats.discogs.draftPercentage.toFixed(1)}%`);
    console.log(`- Estimated actual "For Sale" items: ~${stats.discogs.estimatedForSale}`);
    
    console.log('\nANALYSIS:');
    const difference = stats.local.total - stats.discogs.estimatedForSale;
    if (difference > 0) {
      console.log(`- Database has ${difference} MORE records than estimated Discogs For Sale items`);
    } else if (difference < 0) {
      console.log(`- Database has ${Math.abs(difference)} FEWER records than estimated Discogs For Sale items`);
    } else {
      console.log(`- Database and estimated Discogs For Sale items match exactly (unlikely)`);
    }
    
    if (stats.local.withoutListingId > 0) {
      console.log(`- ${stats.local.withoutListingId} records don't have discogsListingId and will be fixed during sync`);
    }
    
  } catch (error) {
    console.error('Error checking inventory:', error);
  }
}

checkInventory();