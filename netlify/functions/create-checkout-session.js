// netlify/functions/create-checkout-session.js
// Complete version with Stripe and Airtable

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// Airtable configuration (server-side only)
const AIRTABLE_CONFIG = {
    baseId: process.env.AIRTABLE_BASE_ID || 'app5cbzAh0gR71XIz',
    tableId: process.env.AIRTABLE_TABLE_ID || 'tblW2Cljvz76q2Gc7',
    apiToken: process.env.AIRTABLE_API_TOKEN || 'patV6vELlZattM0mz.3f9cbc01e9f266bb6c6ce1b25b8507d14ef9556c3e8b1c5d05428da4e54fe939'
};

// Generate order ID
function generateOrderID() {
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const random = Math.random().toString(36).substr(2, 4).toUpperCase();
    return `FC-${date}-${random}`;
}

// Save order to Airtable
async function saveOrderToAirtable(orderData, orderID) {
    try {
        const customerInfo = `Name: ${orderData.customer.firstName} ${orderData.customer.lastName}\nEmail: ${orderData.customer.email}\nAddress: ${orderData.customer.address}\n${orderData.customer.city}, ${orderData.customer.state} ${orderData.customer.zipCode}`;
        
        const itemsInfo = orderData.items.map(item => {
            let itemDescription = item.name;
            
            // Handle new selectedFlavors format
            if (item.selectedFlavors && item.selectedFlavors.length > 0) {
                const flavorNames = item.selectedFlavors.map(f => f.name).join(', ');
                itemDescription += ` (Flavors: ${flavorNames})`;
            } else if (item.variants) {
                // Handle old variants format
                const variants = Object.values(item.variants).map(v => v.name).join(', ');
                if (variants) {
                    itemDescription += ` (${variants})`;
                }
            }
            
            return `${itemDescription} - Qty: ${item.quantity} - $${(item.price * item.quantity).toFixed(2)}`;
        }).join('\n');

        const addressInfo = `${orderData.customer.address}\n${orderData.customer.city}, ${orderData.customer.state} ${orderData.customer.zipCode}`;

        const record = {
            fields: {
                'Name': `${orderID} - ${orderData.customer.firstName} ${orderData.customer.lastName}`,
                'OrderID': orderID,
                'Customer Info': customerInfo,
                'Items Ordered': itemsInfo,
                'Totals': parseFloat(orderData.totals.total.toFixed(2)),
                'CustEmail': orderData.customer.email,
                'Phone': '',
                'Address': addressInfo,
                'City': orderData.customer.city,
                'State': orderData.customer.state,
                'Zip': orderData.customer.zipCode,
                'Status': 'New',
                'Tracking': ''
            }
        };

        const response = await fetch(`https://api.airtable.com/v0/${AIRTABLE_CONFIG.baseId}/${AIRTABLE_CONFIG.tableId}`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${AIRTABLE_CONFIG.apiToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ records: [record] })
        });

        if (response.ok) {
            const result = await response.json();
            return { success: true, recordId: result.records[0].id };
        } else {
            const error = await response.text();
            console.error('Airtable error:', error);
            return { success: false, error: error };
        }

    } catch (error) {
        console.error('Airtable save error:', error);
        return { success: false, error: error.message };
    }
}

exports.handler = async (event, context) => {
    // Enable CORS
    const headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
    };

    // Handle preflight request
    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 200, headers, body: '' };
    }

    if (event.httpMethod !== 'POST') {
        return {
            statusCode: 405,
            headers,
            body: JSON.stringify({ error: 'Method not allowed' }),
        };
    }

    try {
        const orderData = JSON.parse(event.body);
        const { items, customer, totals } = orderData;

        console.log('Processing order for:', customer.email);

        // Generate order ID
        const orderID = generateOrderID();

        // Save to Airtable first
        const airtableResult = await saveOrderToAirtable(orderData, orderID);
        if (!airtableResult.success) {
            console.error('Airtable save failed:', airtableResult.error);
            // Continue anyway - don't fail the entire checkout
        }

        // Create line items for Stripe
        const lineItems = items.map(item => {
            let itemName = item.name;
            
            // Handle new selectedFlavors format for Stripe display
            if (item.selectedFlavors && item.selectedFlavors.length > 0) {
                const flavorNames = item.selectedFlavors.map(f => f.name).join(', ');
                itemName += ` (Flavors: ${flavorNames})`;
            } else if (item.variants) {
                // Handle old variants format
                const variants = Object.values(item.variants).map(v => v.name).join(', ');
                if (variants) {
                    itemName += ` (${variants})`;
                }
            }
            
            return {
                price_data: {
                    currency: 'usd',
                    product_data: {
                        name: itemName,
                    },
                    unit_amount: Math.round(item.price * 100), // Convert to cents
                },
                quantity: item.quantity,
            };
        });

        // Add shipping if applicable
        if (totals.shipping > 0) {
            lineItems.push({
                price_data: {
                    currency: 'usd',
                    product_data: { name: 'Shipping' },
                    unit_amount: Math.round(totals.shipping * 100),
                },
                quantity: 1,
            });
        }

        // Add tax if applicable
        if (totals.tax > 0) {
            lineItems.push({
                price_data: {
                    currency: 'usd',
                    product_data: { name: 'Tax' },
                    unit_amount: Math.round(totals.tax * 100),
                },
                quantity: 1,
            });
        }

        // Create Stripe checkout session
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: lineItems,
            mode: 'payment',
            success_url: `${process.env.URL || 'https://fuelcraft.netlify.app'}/order-confirmation.html?session_id={CHECKOUT_SESSION_ID}&success=true`,
            cancel_url: `${process.env.URL || 'https://fuelcraft.netlify.app'}/cart.html?canceled=true`,
            customer_email: customer.email,
            shipping_address_collection: {
                allowed_countries: ['US'],
            },
            metadata: {
                orderID: orderID,
                airtableRecordId: airtableResult.recordId || 'not_saved',
                customer_name: `${customer.firstName} ${customer.lastName}`,
                customer_email: customer.email,
                order_total: totals.total.toString(),
            },
        });

        console.log('Stripe session created:', session.id);

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({ 
                sessionId: session.id,
                url: session.url,
                orderID: orderID,
                airtableRecordId: airtableResult.recordId || null
            }),
        };

    } catch (error) {
        console.error('Error processing order:', error);
        
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ 
                error: 'Failed to process order',
                details: error.message 
            }),
        };
    }
};