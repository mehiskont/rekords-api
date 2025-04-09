require('dotenv').config();
const axios = require('axios');
const { getDiscogsClient } = require('./src/controllers/authController');

async function testDiscogsAPI() {
  try {
    console.log('Testing Discogs API with different status values...');
    const discogsClient = await getDiscogsClient();
    const username = process.env.DISCOGS_USERNAME;
    
    console.log(`Using Discogs username: ${username}`);
    
    // Status values to try
    const statusValues = [
      "For Sale", 
      "Sold",
      "Draft",
      "Listed", // This might be the one since it appears in documentation
      undefined // No status parameter
    ];
    
    for (const status of statusValues) {
      console.log(`\n--- Trying with status: ${status || '(none)'} ---`);
      try {
        const response = await discogsClient.get(`/users/${username}/inventory`, {
          params: {
            page: 1,
            per_page: 10,
            ...(status ? { status } : {}),
          },
        });
        
        console.log(`Got ${response.data.listings?.length || 0} listings`);
        console.log(`Total items: ${response.data.pagination?.items || 'unknown'}`);
        
        // Count and display status distribution
        if (response.data.listings && response.data.listings.length > 0) {
          const statusDist = {};
          response.data.listings.forEach(listing => {
            statusDist[listing.status] = (statusDist[listing.status] || 0) + 1;
          });
          console.log(`Status distribution in response: ${JSON.stringify(statusDist)}`);
        }
      } catch (err) {
        console.error(`Error with status "${status}":`, err.message);
      }
      
      // Wait to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    // Now try checking if there's a 'listed' field that might help us
    console.log("\n--- Checking for additional fields in listings... ---");
    const response = await discogsClient.get(`/users/${username}/inventory`, {
      params: {
        page: 1,
        per_page: 1,
      },
    });
      
    // Check listing fields
    if (response.data.listings && response.data.listings.length > 0) {
      const listing = response.data.listings[0];
      console.log("Listing fields:", Object.keys(listing).join(", "));
      console.log("Sample listing:");
      console.log(JSON.stringify(listing, null, 2));
    }
    
  } catch (error) {
    console.error('Error:', error.message);
    if (error.response) {
      console.error('Response error data:', error.response.data);
    }
  }
}

testDiscogsAPI();
