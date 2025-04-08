const inventoryService = require('../services/inventoryService');

// POST /api/inventory/refresh
exports.refreshInventory = async (req, res, next) => {
  // userId is no longer needed for the sync function itself,
  // but we keep ensureAuthenticated on the route to restrict access.
  // const userId = req.session.userId; 

  // Removed userId check
  // if (!userId) { ... }

  try {
    console.log(`Manual inventory refresh requested by user ${req.session.userId || '(unknown, check middleware)'}`);
    // Trigger the sync process (don't wait for it to complete here)
    // Run it in the background - fire and forget for the HTTP request
    inventoryService.syncDiscogsInventory() // Call without userId
      .then(result => {
        console.log(`Background manual inventory sync finished:`, result);
        // TODO: Optionally notify user via WebSocket or other means upon completion/error
      })
      .catch(error => {
        console.error(`Background manual inventory sync failed:`, error);
        // TODO: Log error more permanently
      });

    // Respond immediately to the client
    res.status(202).json({ message: 'Inventory sync initiated successfully. It will run in the background.' });

  } catch (error) {
    console.error(`Error initiating manual inventory refresh:`, error);
    res.status(500).json({ message: 'Failed to start inventory sync' });
    // next(error);
  }
};
