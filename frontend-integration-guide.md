# Frontend Integration Guide for Persistent Cart Management

This guide explains how to implement cart persistence and merging in your Next.js frontend with NextAuth.js, working with the Plastik API backend.

## Prerequisites

- Next.js frontend app using NextAuth.js for authentication
- Plastik API backend with session-based authentication
- Environment variables properly configured

## Setting Up Environment Variables

Add these to your Next.js `.env.local` file:

```bash
# Auth configuration
NEXTAUTH_URL=http://localhost:3000
NEXT_PUBLIC_API_URL=http://localhost:3001
```

## Cart Data Flow

1. **Guest Users**: Cart stored in `localStorage`
2. **Logged-in Users**: Cart stored in database (persistent)
3. **During Login**: Guest cart automatically merged with user's database cart

## Frontend Implementation Steps

### 1. Configure NextAuth.js

In `pages/api/auth/[...nextauth].js`:

```javascript
import NextAuth from 'next-auth'
import CredentialsProvider from 'next-auth/providers/credentials'

export default NextAuth({
  providers: [
    CredentialsProvider({
      name: 'Credentials',
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" }
      },
      async authorize(credentials) {
        try {
          const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/auth/nextauth-callback`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(credentials),
            credentials: 'include',
          });
          
          const data = await response.json();
          
          if (!response.ok) {
            throw new Error(data.error || 'Authentication failed');
          }
          
          return data; // Contains user data and shouldMergeCart flag
        } catch (error) {
          console.error('Auth error:', error);
          return null;
        }
      }
    })
  ],
  callbacks: {
    async jwt({ token, user }) {
      // Forward the shouldMergeCart flag from authorize response to the session
      if (user?.shouldMergeCart) {
        token.shouldMergeCart = true;
      }
      return token;
    },
    async session({ session, token }) {
      // Make shouldMergeCart available in session
      if (token.shouldMergeCart) {
        session.shouldMergeCart = true;
        // Clear this flag after first usage
        token.shouldMergeCart = false;
      }
      return session;
    }
  },
  session: {
    strategy: 'jwt', // Use JWT strategy for NextAuth session
  },
  cookies: {
    // Configure cookies to be compatible with backend session cookies
    sessionToken: {
      name: 'next-auth.session-token',
      options: {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        secure: process.env.NODE_ENV === 'production',
      }
    }
  }
})
```

### 2. Implement Cart Context

Create a `contexts/CartContext.js` file:

```javascript
import { createContext, useContext, useState, useEffect } from 'react';
import { useSession, signIn } from 'next-auth/react';
import { fetchApi } from '../utils/api'; // Your API utility function

const CartContext = createContext();

export function CartProvider({ children }) {
  const { data: session, status } = useSession();
  const [cart, setCart] = useState({ items: [] });
  const [loading, setLoading] = useState(true);
  
  // Check if user is authenticated
  const isAuthenticated = status === 'authenticated';
  
  // Fetch user's cart from the database when authenticated
  useEffect(() => {
    if (isAuthenticated) {
      fetchUserCart();
    } else if (status === 'unauthenticated') {
      // Load guest cart from localStorage
      loadGuestCart();
      setLoading(false);
    }
  }, [isAuthenticated, status]);
  
  // Check for cart merge flag in session after login
  useEffect(() => {
    if (session?.shouldMergeCart) {
      mergeGuestCartWithUserCart();
    }
  }, [session]);
  
  // Fetch authenticated user's cart from API
  const fetchUserCart = async () => {
    try {
      setLoading(true);
      const response = await fetchApi('/api/cart');
      setCart(response);
    } catch (error) {
      console.error('Error fetching cart:', error);
    } finally {
      setLoading(false);
    }
  };
  
  // Load guest cart from localStorage
  const loadGuestCart = () => {
    try {
      const guestCartData = localStorage.getItem('guestCart');
      if (guestCartData) {
        setCart(JSON.parse(guestCartData));
      } else {
        setCart({ items: [] });
      }
    } catch (error) {
      console.error('Error loading guest cart:', error);
      setCart({ items: [] });
    }
  };
  
  // Save guest cart to localStorage
  const saveGuestCart = (cartData) => {
    try {
      localStorage.setItem('guestCart', JSON.stringify(cartData));
    } catch (error) {
      console.error('Error saving guest cart:', error);
    }
  };
  
  // Add item to cart (either localStorage or API)
  const addToCart = async (recordId, quantity) => {
    if (isAuthenticated) {
      try {
        setLoading(true);
        const response = await fetchApi('/api/cart/items', {
          method: 'POST',
          body: JSON.stringify({ recordId, quantity }),
        });
        setCart(response);
      } catch (error) {
        console.error('Error adding to cart:', error);
        throw error;
      } finally {
        setLoading(false);
      }
    } else {
      // Guest cart logic - store in localStorage
      const updatedCart = { ...cart };
      const existingItem = updatedCart.items.find(item => item.recordId === recordId);
      
      if (existingItem) {
        existingItem.quantity += quantity;
      } else {
        updatedCart.items.push({ 
          recordId, 
          quantity, 
          id: `guest-${Date.now()}` // Temporary ID for guest cart
        });
      }
      
      setCart(updatedCart);
      saveGuestCart(updatedCart);
    }
  };
  
  // Update cart item quantity
  const updateCartItemQuantity = async (itemId, quantity) => {
    if (isAuthenticated) {
      try {
        setLoading(true);
        const response = await fetchApi(`/api/cart/items/${itemId}`, {
          method: 'PUT',
          body: JSON.stringify({ quantity }),
        });
        setCart(response);
      } catch (error) {
        console.error('Error updating cart item:', error);
        throw error;
      } finally {
        setLoading(false);
      }
    } else {
      // Guest cart logic
      const updatedCart = { ...cart };
      const itemIndex = updatedCart.items.findIndex(item => item.id === itemId);
      
      if (itemIndex !== -1) {
        updatedCart.items[itemIndex].quantity = quantity;
        setCart(updatedCart);
        saveGuestCart(updatedCart);
      }
    }
  };
  
  // Remove item from cart
  const removeFromCart = async (itemId) => {
    if (isAuthenticated) {
      try {
        setLoading(true);
        const response = await fetchApi(`/api/cart/items/${itemId}`, {
          method: 'DELETE',
        });
        setCart(response);
      } catch (error) {
        console.error('Error removing from cart:', error);
        throw error;
      } finally {
        setLoading(false);
      }
    } else {
      // Guest cart logic
      const updatedCart = { 
        ...cart,
        items: cart.items.filter(item => item.id !== itemId)
      };
      setCart(updatedCart);
      saveGuestCart(updatedCart);
    }
  };
  
  // Merge guest cart with user cart after login
  const mergeGuestCartWithUserCart = async () => {
    try {
      // Get guest cart from localStorage
      const guestCartData = localStorage.getItem('guestCart');
      
      if (!guestCartData) return;
      
      const guestCart = JSON.parse(guestCartData);
      
      if (!guestCart.items || guestCart.items.length === 0) return;
      
      // Format items for API
      const guestCartItems = guestCart.items.map(item => ({
        recordId: item.recordId,
        quantity: item.quantity
      }));
      
      // Call merge API
      const response = await fetchApi('/api/cart/merge', {
        method: 'POST',
        body: JSON.stringify({ guestCartItems }),
      });
      
      // Update cart with merged result
      setCart(response);
      
      // Clear guest cart from localStorage after successful merge
      localStorage.removeItem('guestCart');
      
    } catch (error) {
      console.error('Error merging cart:', error);
    }
  };
  
  return (
    <CartContext.Provider
      value={{
        cart,
        loading,
        addToCart,
        updateCartItemQuantity,
        removeFromCart,
        refreshCart: fetchUserCart
      }}
    >
      {children}
    </CartContext.Provider>
  );
}

export const useCart = () => useContext(CartContext);
```

### 3. API Utility Function

Create a `utils/api.js` file:

```javascript
export async function fetchApi(endpoint, options = {}) {
  // Ensure options has headers
  options.headers = options.headers || {};
  
  // Set content type if sending data
  if (options.body && !options.headers['Content-Type']) {
    options.headers['Content-Type'] = 'application/json';
  }
  
  // Include credentials to send cookies with request
  options.credentials = 'include';
  
  // Make the API request
  const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL}${endpoint}`, options);
  
  // Parse the JSON response
  const data = await response.json();
  
  // Handle error responses
  if (!response.ok) {
    const error = new Error(data.message || 'API request failed');
    error.status = response.status;
    error.data = data;
    throw error;
  }
  
  return data;
}
```

### 4. Setup Provider in _app.js

Add the Cart provider to your `_app.js`:

```javascript
import { SessionProvider } from 'next-auth/react';
import { CartProvider } from '../contexts/CartContext';

function MyApp({ Component, pageProps }) {
  return (
    <SessionProvider session={pageProps.session}>
      <CartProvider>
        <Component {...pageProps} />
      </CartProvider>
    </SessionProvider>
  );
}

export default MyApp;
```

## Usage Examples

### Displaying Cart Items

```jsx
import { useCart } from '../contexts/CartContext';

function CartPage() {
  const { cart, loading, updateCartItemQuantity, removeFromCart } = useCart();
  
  if (loading) return <div>Loading cart...</div>;
  
  return (
    <div>
      <h1>Your Cart</h1>
      {cart.items.length === 0 ? (
        <p>Your cart is empty</p>
      ) : (
        <ul>
          {cart.items.map(item => (
            <li key={item.id}>
              {item.record?.title || 'Unknown Item'} - Quantity: {item.quantity}
              <button onClick={() => updateCartItemQuantity(item.id, item.quantity + 1)}>+</button>
              <button onClick={() => updateCartItemQuantity(item.id, item.quantity - 1)}>-</button>
              <button onClick={() => removeFromCart(item.id)}>Remove</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

### Adding Items to Cart

```jsx
import { useCart } from '../contexts/CartContext';

function ProductDetail({ record }) {
  const { addToCart } = useCart();
  const [quantity, setQuantity] = useState(1);
  
  const handleAddToCart = async () => {
    try {
      await addToCart(record.id, quantity);
      // Show success message
    } catch (error) {
      // Handle error
    }
  };
  
  return (
    <div>
      <h1>{record.title}</h1>
      <p>Price: ${record.price}</p>
      <input 
        type="number" 
        value={quantity} 
        onChange={(e) => setQuantity(parseInt(e.target.value, 10))} 
        min="1" 
      />
      <button onClick={handleAddToCart}>Add to Cart</button>
    </div>
  );
}
```

## Testing Cart Functionality

1. **Guest Cart**: Add items to cart while logged out
2. **Login**: Sign in using NextAuth.js
3. **Verify Merge**: Check that guest cart items merged into user cart
4. **Persistence**: Log out and back in to verify cart persists

## Troubleshooting

- **Cookies Not Sent**: Ensure `credentials: 'include'` is set on API requests
- **CORS Errors**: Verify backend CORS configuration allows your frontend domain
- **Cart Not Merging**: Check NextAuth callbacks properly pass the `shouldMergeCart` flag
- **Cart Items Missing**: Ensure backend API calls are properly authenticated with cookies