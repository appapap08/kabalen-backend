// server.js
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
const multer = require('multer');

const app = express();
app.use(cors());
app.use(bodyParser.json());

const SECRET_KEY = "supersecretkey";
const DATA_FILE = path.join(__dirname, 'data.json');
const uploadDir = path.join(__dirname, '../front-end/uploads');

// Ensure uploads folder exists
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

// Multer setup for file uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
        const uniqueName = `${file.fieldname}_${Date.now()}${path.extname(file.originalname)}`;
        cb(null, uniqueName);
    }
});
const upload = multer({ storage });

// Serve static files
app.use(express.static(path.join(__dirname, '../front-end')));

// Default route
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '../front-end/index.html'));
});

// --- Load and Save Data ---
function loadData() {
    if (!fs.existsSync(DATA_FILE)) {
        fs.writeFileSync(DATA_FILE, JSON.stringify({
            riders: [], orders: [], clients: [], nextRiderId: 1, nextOrderId: 1, nextClientId: 1
        }, null, 2));
    }
    return JSON.parse(fs.readFileSync(DATA_FILE));
}

function saveData(data) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// --- Admin Login ---
app.post('/admin/login', (req, res) => {
    const { username, password } = req.body;
    if (username === 'admin' && password === '123') {
        const token = jwt.sign({ username }, SECRET_KEY, { expiresIn: '12h' });
        return res.json({ token });
    }
    res.status(401).json({ message: 'Invalid credentials' });
});

// --- Auth Middleware ---
function auth(req, res, next) {
    const authHeader = req.headers['authorization'];
    if (!authHeader) return res.status(401).json({ message: 'Missing token' });
    const token = authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ message: 'Missing token' });
    try {
        req.user = jwt.verify(token, SECRET_KEY);
        next();
    } catch (err) {
        res.status(403).json({ message: 'Invalid token' });
    }
}

// --- Riders CRUD ---
app.get('/riders', auth, (req, res) => {
    const data = loadData();
    res.json(data.riders);
});

app.post('/riders', auth, (req, res) => {
    const { name, phone, username, password } = req.body;
    if (!name || !phone || !username || !password) return res.status(400).json({ message: 'All fields required' });
    const data = loadData();
    const newRider = { id: data.nextRiderId++, name, phone, username, password, credit: 0 };
    data.riders.push(newRider);
    saveData(data);
    res.json(newRider);
});

app.post('/riders/:id/coins', auth, (req, res) => {
    const riderId = parseInt(req.params.id);
    const { coins } = req.body;
    const data = loadData();
    const rider = data.riders.find(r => r.id === riderId);
    if (!rider) return res.status(404).json({ message: 'Rider not found' });
    if (!coins || isNaN(coins)) return res.status(400).json({ message: 'Invalid coins value' });
    rider.credit += parseFloat(coins);
    saveData(data);
    res.json({ message: `Added ${coins} coins to rider ${rider.name}`, credit: rider.credit });
});

// --- Rider Login ---
app.post('/rider/login', (req, res) => {
    const { username, password } = req.body;
    const data = loadData();
    const rider = data.riders.find(r => r.username === username && r.password === password);
    if (!rider) return res.status(401).json({ message: 'Invalid username or password' });
    const token = jwt.sign({ riderId: rider.id }, SECRET_KEY, { expiresIn: '12h' });
    res.json({ token, rider });
});

// --- Rider Orders (All statuses for assigned rider) ---
app.get('/rider/orders', auth, (req, res) => {
    const riderId = req.user.riderId;
    const data = loadData();

    // Map client info if client_id exists
    const ordersWithClientInfo = data.orders
        .filter(o => o.rider_id === riderId || o.status === 'Pending')
        .map(o => {
            let customerName = o.customer_name || '-';
            let customerPhone = o.customer_phone || '-';
            if(o.client_id){
                const client = data.clients.find(c => c.id === o.client_id);
                if(client){
                    customerName = client.fullname;
                    customerPhone = client.phone;
                }
            }
            return { ...o, customer_name: customerName, customer_phone: customerPhone };
        });

    res.json(ordersWithClientInfo);
});

app.post('/rider/orders/:id/accept', auth, (req, res) => {
    const riderId = req.user.riderId;
    const orderId = parseInt(req.params.id);
    const data = loadData();
    const order = data.orders.find(o => o.id === orderId);
    if (!order) return res.status(404).json({ message: 'Order not found' });
    if (order.rider_id && order.rider_id !== riderId) return res.status(403).json({ message: 'Order already assigned' });
    order.rider_id = riderId;
    order.status = 'Accepted';
    saveData(data);
    res.json({ message: 'Order accepted', order });
});

// --- Complete Order (Rider) ---
app.post('/rider/orders/:id/complete', auth, (req, res) => {
    const riderId = req.user.riderId;
    const orderId = parseInt(req.params.id);
    const data = loadData();
    const order = data.orders.find(o => o.id === orderId);

    if (!order) return res.status(404).json({ message: 'Order not found' });
    if (order.rider_id !== riderId) return res.status(403).json({ message: 'Not authorized to complete this order' });
    if (!order.dropoff_image) return res.status(400).json({ message: 'Dropoff proof required before completing' });

    order.status = 'Completed';
    saveData(data);
    res.json({ message: 'Order marked as completed', order });
});

// --- Orders ---
app.get('/orders', auth, (req, res) => {
    const data = loadData();
    res.json(data.orders);
});

app.post('/orders/manual', auth, (req, res) => {
    const { customer_name, customer_phone, pickup, dropoff, distance, fee, rider_id } = req.body;
    if (!customer_name || !pickup || !dropoff) return res.status(400).json({ message: 'Missing fields' });
    const data = loadData();
    const newOrder = {
        id: data.nextOrderId++,
        client_id: null,
        customer_name,
        customer_phone,
        pickup,
        dropoff,
        distance: distance || 0,
        fee: fee || 0,
        status: rider_id ? 'Accepted' : 'Pending',
        rider_id: rider_id || null,
        pickup_image: null,
        dropoff_image: null
    };
    data.orders.push(newOrder);
    saveData(data);
    res.json(newOrder);
});

// --- Upload proofs ---
app.post('/orders/:id/upload', auth, upload.single('image'), (req, res) => {
    const orderId = parseInt(req.params.id);
    const type = req.body.type; // "pickup" or "dropoff"
    const data = loadData();
    const order = data.orders.find(o => o.id === orderId);
    if (!order) return res.status(404).json({ message: 'Order not found' });
    if (!req.file) return res.status(400).json({ message: 'File required' });
    if (type === 'pickup') order.pickup_image = req.file.filename;
    if (type === 'dropoff') order.dropoff_image = req.file.filename;
    saveData(data);
    res.json({ message: 'Image uploaded', filename: req.file.filename });
});

// --- Assign / Cancel Orders ---
app.post('/orders/:id/assign', auth, (req, res) => {
    const orderId = parseInt(req.params.id);
    const { riderId } = req.body;
    const data = loadData();
    const order = data.orders.find(o => o.id === orderId);
    if (!order) return res.status(404).json({ message: 'Order not found' });
    order.rider_id = riderId || null;
    order.status = riderId ? 'Accepted' : 'Pending';
    saveData(data);
    res.json({ message: riderId ? 'Order assigned' : 'Order cancelled' });
});
// --- Client Registration ---
app.post('/clients/register', upload.fields([{ name: 'validId' }, { name: 'selfie' }]), (req, res) => {
    const { fullname, address, phone, username, password } = req.body;
    const validIdFile = req.files['validId'] ? req.files['validId'][0].filename : null;
    const selfieFile = req.files['selfie'] ? req.files['selfie'][0].filename : null;

    if (!fullname || !address || !phone || !username || !password || !validIdFile || !selfieFile) {
        return res.status(400).json({ message: 'All fields including files are required' });
    }

    const data = loadData();

    // Check if username already exists
    if (data.clients.find(c => c.username === username)) {
        return res.status(400).json({ message: 'Username already taken' });
    }

    const newClient = {
        id: data.nextClientId++,
        fullname,
        address,
        phone,
        username,
        password,
        validId: validIdFile,
        selfie: selfieFile
    };

    data.clients.push(newClient);
    saveData(data);

    res.json({ message: 'Registration successful', client: newClient });
});

// --- Client Login ---
app.post('/clients/login', (req, res) => {
    const { username, password } = req.body;
    const data = loadData();
    const client = data.clients.find(c => c.username === username && c.password === password);
    if (!client) return res.status(401).json({ message: 'Invalid username or password' });

    const token = jwt.sign({ clientId: client.id }, SECRET_KEY, { expiresIn: '12h' });
    res.json({ token, client });
});

// --- Client Orders ---
app.post('/clients/orders', auth, (req, res) => {
    const { pickup, dropoff, distance, fee, type, notes } = req.body; // 🧡 added notes here
    const clientId = req.user.clientId;
    const data = loadData();

    if (!pickup || !dropoff) 
        return res.status(400).json({ message: 'Pickup and dropoff required' });

    const newOrder = {
        id: data.nextOrderId++,
        client_id: clientId,
        pickup,
        dropoff,
        distance: distance || 0,
        fee: fee || 0,
        type: type || 'general',
        notes: notes || '', // 🧡 include notes
        status: 'Pending',
        rider_id: null,
        pickup_image: null,
        dropoff_image: null
    };

    data.orders.push(newOrder);
    saveData(data);

    res.json({ message: 'Order placed', order: newOrder });
});

app.get('/clients/orders', auth, (req, res) => {
    const clientId = req.user.clientId;
    const data = loadData();
    const clientOrders = data.orders.filter(o => o.client_id === clientId);
    res.json(clientOrders);
});

// --- Start server ---
const PORT = process.env.PORT || 3500;
app.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));
