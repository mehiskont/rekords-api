require('dotenv').config();
const { getDiscogsClient } = require('./src/controllers/authController');

async function testFilter() {
  try {
    console.log('Testing Discogs Draft status filter...');
    const discogsClient = await getDiscogsClient();
    const username = process.env.DISCOGS_USERNAME;
    
    console.log(`Using Discogs username: ${username}`);
    
    // Get one page of data
    const response = await discogsClient.get(`/users/${username}/inventory`, {
      params: {
        page: 1,
        per_page: 50,
        status: 'For Sale',  // Include this but it doesn't actually filter correctly
      },
    });
    
    console.log(`Total items in page: ${response.data.listings?.length || 0}`);
    
    // Count status distribution
    const statusCount = {};
    response.data.listings.forEach(listing => {
      statusCount[listing.status] = (statusCount[listing.status] || 0) + 1;
    });
    console.log(`Status distribution: ${JSON.stringify(statusCount)}`);
    
    // Apply our filter
    const draftListings = response.data.listings.filter(listing => listing.status === 'Draft');
    console.log(`After filtering for 'Draft' status: ${draftListings.length} listings`);
    
    // Check if this is roughly 68% of the total (34 out of 50)
    const percentage = (draftListings.length / response.data.listings.length) * 100;
    console.log(`Draft items make up ${percentage.toFixed(1)}% of the listings`);
    
    // Based on our page sample, project the total number of Draft items across all pages
    const totalPages = response.data.pagination.pages;
    const estimatedDraftItems = Math.round(draftListings.length * totalPages);
    console.log(`Estimated 'For Sale' (Draft) items across all ${totalPages} pages: ~${estimatedDraftItems}`);
    
  } catch (error) {
    console.error('Error:', error.message);
  }
}

testFilter();