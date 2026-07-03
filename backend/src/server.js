const express = require("express");
const cors = require("cors");
const fsSync = require("fs");
const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const nodemailer = require("nodemailer");
const multer = require("multer");
const jwt = require("jsonwebtoken");

const app = express();
const PORT = process.env.PORT || 4000;
const BACKEND_DIR = path.resolve(__dirname, "..");
const PROJECT_DIR = path.resolve(BACKEND_DIR, "..");
const STORE_FILE = path.join(BACKEND_DIR, "data", "store.json");
const FRONTEND_DIR = path.join(PROJECT_DIR, "frontend");
const UPLOADS_DIR = path.join(BACKEND_DIR, "uploads");
const EMAIL_CODE_TTL_MS = 10 * 60 * 1000;
const emailCodeStore = new Map();

const JWT_SECRET = process.env.ADMIN_JWT_SECRET || "change-this-in-production";
const JWT_EXPIRES_IN = process.env.ADMIN_JWT_EXPIRES_IN || "12h";
const ADMIN_PASSCODE = process.env.ADMIN_PASSCODE || "admin";
const ADMIN_STAFF_EMAILS = String(process.env.ADMIN_STAFF_EMAILS || "")
  .split(",")
  .map((email) => String(email || "").trim().toLowerCase())
  .filter(Boolean);

app.use(cors());
app.use(express.json());

if (!fsSync.existsSync(UPLOADS_DIR)) {
  fsSync.mkdirSync(UPLOADS_DIR, { recursive: true });
}

const uploadStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, UPLOADS_DIR);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || "") || ".jpg";
    cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);
  }
});

const uploadImage = multer({
  storage: uploadStorage,
  limits: { fileSize: 6 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (String(file.mimetype || "").startsWith("image/")) {
      cb(null, true);
      return;
    }
    cb(new Error("Only image files are allowed"));
  }
});

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function hashSecret(secret) {
  return crypto.createHash("sha256").update(String(secret || "")).digest("hex");
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function ensureVariant(variant, fallbackPhoto, fallbackPrice, fallbackSizes) {
  if (!variant || typeof variant !== "object") return null;
  const color = String(variant.color || "").trim();
  const size = String(variant.size || "").trim().toUpperCase();
  const stock = Number.isFinite(Number(variant.stock)) ? Math.max(0, Number(variant.stock)) : 0;
  const price = Number.isFinite(Number(variant.price)) ? Number(variant.price) : Number(fallbackPrice) || 0;
  const photo = String(variant.photo || fallbackPhoto || "").trim();

  if (!color || !size || !photo) return null;

  return {
    id: String(variant.id || `${color}-${size}`).trim(),
    color,
    size,
    stock,
    price,
    photo,
    soldOut: stock <= 0
  };
}

function normalizeProduct(product) {
  if (!product || typeof product !== "object") return null;
  const normalizedNameZh = String(product.nameZh || "").trim();
  const normalizedNameEn = String(product.nameEn || product.title || product.desc || "").trim();
  const normalizedCategory = String(product.category || "").trim();
  const normalizedDesc = String(product.desc || normalizedNameEn || normalizedNameZh).trim();
  const sizes = Array.isArray(product.sizes) && product.sizes.length
    ? product.sizes.map((entry) => String(entry).trim().toUpperCase()).filter(Boolean)
    : ["S", "M", "L"];

  let variants = Array.isArray(product.variants)
    ? product.variants
        .map((variant) => ensureVariant(variant, product.photo, product.price, sizes))
        .filter(Boolean)
    : [];

  if (!variants.length) {
    const fallbackStock = Number.isFinite(Number(product.stock)) ? Math.max(0, Number(product.stock)) : 20;
    variants = sizes.map((size) => ({
      id: `DEFAULT-${size}`,
      color: "Default",
      size,
      stock: fallbackStock,
      price: Number.isFinite(Number(product.price)) ? Number(product.price) : 0,
      photo: String(product.photo || "").trim(),
      soldOut: fallbackStock <= 0
    })).filter((entry) => entry.photo);
  }

  const totalStock = variants.length
    ? variants.reduce((sum, variant) => sum + Number(variant.stock || 0), 0)
    : Number.isFinite(Number(product.stock)) ? Math.max(0, Number(product.stock)) : 0;

  return {
    id: Number(product.id) || Date.now(),
    photo: String(product.photo || variants[0]?.photo || "").trim(),
    price: Number.isFinite(Number(product.price)) ? Number(product.price) : Number(variants[0]?.price || 0),
    nameZh: normalizedNameZh,
    nameEn: normalizedNameEn,
    desc: normalizedDesc,
    category: normalizedCategory,
    sizes,
    seenAt: String(product.seenAt || "").trim(),
    sizeChart: String(product.sizeChart || "").trim(),
    washingInfo: String(product.washingInfo || "").trim(),
    variants,
    stock: totalStock,
    soldOut: totalStock <= 0
  };
}

function normalizeCoupon(coupon) {
  if (!coupon || typeof coupon !== "object") return null;
  const code = String(coupon.code || "").trim().toUpperCase();
  if (!code) return null;

  const type = coupon.type === "fixed" ? "fixed" : "percent";
  const value = Number.isFinite(Number(coupon.value)) ? Number(coupon.value) : 0;
  const minSpend = Number.isFinite(Number(coupon.minSpend)) ? Number(coupon.minSpend) : 0;
  const targetProductId = coupon.targetProductId ? Number(coupon.targetProductId) : null;
  const active = coupon.active !== false;

  return {
    code,
    type,
    value,
    minSpend,
    targetProductId,
    active,
    description: String(coupon.description || "").trim()
  };
}

async function readStore() {
  const raw = await fs.readFile(STORE_FILE, "utf8");
  const store = JSON.parse(raw);

  store.products = Array.isArray(store.products) ? store.products.map(normalizeProduct).filter(Boolean) : [];
  store.orders = Array.isArray(store.orders) ? store.orders : [];
  store.users = Array.isArray(store.users) ? store.users : [];
  store.paymentQr = store.paymentQr || {};
  store.coupons = Array.isArray(store.coupons) ? store.coupons.map(normalizeCoupon).filter(Boolean) : [];
  store.adminStaff = Array.isArray(store.adminStaff) ? store.adminStaff : [];
  store.categories = Array.isArray(store.categories) ? store.categories : [];
  store.shippingRules = store.shippingRules || {
    freeShippingThreshold: 500,
    defaultShippingFee: 35
  };

  if (!store.adminStaff.length) {
    const ownerEmail = ADMIN_STAFF_EMAILS[0] || "owner@seance.local";
    store.adminStaff.push({
      id: Date.now(),
      email: ownerEmail,
      name: "Owner",
      role: "owner",
      passwordHash: hashSecret(ADMIN_PASSCODE)
    });
    await writeStore(store);
  }

  return store;
}

async function writeStore(store) {
  await fs.writeFile(STORE_FILE, JSON.stringify(store, null, 2), "utf8");
}

async function upsertUserProfile({ email, phone, name, language }) {
  const normalizedEmail = normalizeEmail(email);
  const cleanPhone = String(phone || "").trim();
  const cleanName = String(name || "").trim();
  const cleanLanguage = language === "zh" ? "zh" : "en";

  const store = await readStore();
  const existingIndex = store.users.findIndex((entry) => String(entry.email || "").toLowerCase() === normalizedEmail);
  const user = {
    id: existingIndex >= 0 ? store.users[existingIndex].id : Date.now(),
    email: normalizedEmail,
    phone: cleanPhone,
    name: cleanName,
    language: cleanLanguage,
    updatedAt: new Date().toISOString(),
    createdAt: existingIndex >= 0 ? store.users[existingIndex].createdAt : new Date().toISOString()
  };

  if (existingIndex >= 0) {
    store.users[existingIndex] = { ...store.users[existingIndex], ...user };
  } else {
    store.users.unshift(user);
  }

  await writeStore(store);
  return { user, isUpdate: existingIndex >= 0 };
}

function buildSmtpTransporter() {
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 587);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const secure = String(process.env.SMTP_SECURE || "false").toLowerCase() === "true";

  if (!host || !user || !pass) {
    throw new Error("Email sender is not configured. Please set SMTP_HOST, SMTP_USER, and SMTP_PASS.");
  }

  return nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user, pass }
  });
}

function signAdminToken({ email }) {
  return jwt.sign({ role: "admin", email: normalizeEmail(email || "staff@local") }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

function getBearerToken(req) {
  const header = String(req.headers.authorization || "");
  if (!header.startsWith("Bearer ")) return "";
  return header.slice(7).trim();
}

function requireAdmin(req, res, next) {
  try {
    const token = getBearerToken(req);
    if (!token) {
      return res.status(401).json({ error: "Admin token required" });
    }
    const payload = jwt.verify(token, JWT_SECRET);
    if (!payload || payload.role !== "admin") {
      return res.status(403).json({ error: "Admin access denied" });
    }
    req.admin = payload;
    return next();
  } catch (_error) {
    return res.status(401).json({ error: "Invalid or expired admin token" });
  }
}

function computeOrderPrice({ items, coupons, shippingRules, couponCode }) {
  const subtotal = items.reduce((sum, item) => sum + Number(item.price || 0) * Number(item.qty || 1), 0);
  const normalizedCode = String(couponCode || "").trim().toUpperCase();

  let discount = 0;
  let appliedCoupon = null;
  if (normalizedCode) {
    const coupon = coupons.find((entry) => entry.active && entry.code === normalizedCode);
    if (coupon && subtotal >= Number(coupon.minSpend || 0)) {
      const appliesToProduct = coupon.targetProductId
        ? items.some((item) => Number(item.id) === Number(coupon.targetProductId))
        : true;
      if (appliesToProduct) {
        if (coupon.type === "fixed") {
          discount = Math.max(0, Math.min(subtotal, Number(coupon.value || 0)));
        } else {
          discount = Math.max(0, Math.min(subtotal, subtotal * (Number(coupon.value || 0) / 100)));
        }
        appliedCoupon = coupon;
      }
    }
  }

  const afterDiscount = Math.max(0, subtotal - discount);
  const freeThreshold = Number(shippingRules.freeShippingThreshold || 500);
  const baseShippingFee = Number(shippingRules.defaultShippingFee || 35);
  const shippingFee = afterDiscount >= freeThreshold ? 0 : baseShippingFee;

  return {
    subtotal,
    discount,
    shippingFee,
    total: afterDiscount + shippingFee,
    appliedCouponCode: appliedCoupon ? appliedCoupon.code : ""
  };
}

function updateInventoryFromOrder(store, items) {
  const failed = [];

  for (const item of items) {
    const qty = Math.max(1, Number(item.qty || 1));
    const productId = Number(item.id);
    const product = store.products.find((entry) => Number(entry.id) === productId);
    if (!product) {
      failed.push({ id: productId, reason: "Product not found" });
      continue;
    }

    if (!Array.isArray(product.variants) || product.variants.length === 0) {
      if (Number(product.stock || 0) < qty) {
        failed.push({ id: productId, reason: "Out of stock" });
        continue;
      }
      product.stock = Math.max(0, Number(product.stock || 0) - qty);
      product.soldOut = product.stock <= 0;
      continue;
    }

    const color = String(item.variantColor || "").trim();
    const size = String(item.variantSize || "").trim().toUpperCase();
    const variant = color && size
      ? product.variants.find((entry) => entry.color === color && entry.size === size)
      : (product.variants.find((entry) => Number(entry.stock || 0) > 0) || product.variants[0]);
    if (!variant) {
      failed.push({ id: productId, reason: "Variant not found" });
      continue;
    }

    if (Number(variant.stock || 0) < qty) {
      failed.push({ id: productId, reason: "Variant out of stock", color, size });
      continue;
    }

    variant.stock = Math.max(0, Number(variant.stock || 0) - qty);
    variant.soldOut = variant.stock <= 0;

    product.stock = product.variants.reduce((sum, entry) => sum + Number(entry.stock || 0), 0);
    product.soldOut = product.stock <= 0;
  }

  return failed;
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/api/admin/login", async (req, res) => {
  try {
    const passcode = String(req.body.passcode || "").trim();
    const email = normalizeEmail(req.body.email);

    if (!email || !passcode) {
      return res.status(400).json({ error: "Email and password are required" });
    }

    const store = await readStore();
    const staff = store.adminStaff.find((entry) => normalizeEmail(entry.email) === email);
    if (!staff || staff.passwordHash !== hashSecret(passcode)) {
      return res.status(401).json({ error: "Invalid admin credentials" });
    }

    const token = signAdminToken({ email });
    return res.json({ token, role: "admin", email, name: staff.name || "Staff" });
  } catch (_error) {
    return res.status(500).json({ error: "Admin login failed" });
  }
});

app.get("/api/admin/session", requireAdmin, (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/store", async (_req, res) => {
  try {
    const store = await readStore();
    res.json(store);
  } catch (_error) {
    res.status(500).json({ error: "Failed to load store data" });
  }
});

app.get("/api/admin/low-stock", requireAdmin, async (req, res) => {
  try {
    const threshold = Number(req.query.threshold) || 5;
    const store = await readStore();
    const lowStockItems = [];
    for (const product of store.products) {
      for (const variant of (product.variants || [])) {
        if (Number(variant.stock || 0) <= threshold) {
          lowStockItems.push({
            productId: product.id,
            productName: product.nameZh || product.nameEn || product.desc,
            variantId: variant.id,
            color: variant.color,
            size: variant.size,
            stock: variant.stock
          });
        }
      }
    }
    res.json(lowStockItems);
  } catch (_error) {
    res.status(500).json({ error: "Failed to load low stock" });
  }
});

app.delete("/api/orders/:id", requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const store = await readStore();
    const before = store.orders.length;
    store.orders = store.orders.filter((entry) => Number(entry.id) !== id);
    if (store.orders.length === before) {
      return res.status(404).json({ error: "Order not found" });
    }
    await writeStore(store);
    return res.status(204).send();
  } catch (_error) {
    return res.status(500).json({ error: "Failed to delete order" });
  }
});

app.get("/api/products", async (_req, res) => {
  try {
    const store = await readStore();
    res.json(store.products || []);
  } catch (_error) {
    res.status(500).json({ error: "Failed to load products" });
  }
});

app.get("/api/coupons", async (_req, res) => {
  try {
    const store = await readStore();
    res.json(store.coupons || []);
  } catch (_error) {
    res.status(500).json({ error: "Failed to load coupons" });
  }
});

app.get("/api/shipping-rules", async (_req, res) => {
  try {
    const store = await readStore();
    res.json(store.shippingRules || { freeShippingThreshold: 500, defaultShippingFee: 35 });
  } catch (_error) {
    res.status(500).json({ error: "Failed to load shipping rules" });
  }
});

app.get("/api/orders", async (_req, res) => {
  try {
    const store = await readStore();
    res.json(store.orders || []);
  } catch (_error) {
    res.status(500).json({ error: "Failed to load orders" });
  }
});

app.get("/api/admin/orders", requireAdmin, async (_req, res) => {
  try {
    const store = await readStore();
    res.json(store.orders || []);
  } catch (_error) {
    res.status(500).json({ error: "Failed to load admin orders" });
  }
});

app.get("/api/admin/staff", requireAdmin, async (_req, res) => {
  try {
    const store = await readStore();
    const output = store.adminStaff.map((entry) => ({
      id: entry.id,
      email: entry.email,
      name: entry.name,
      role: entry.role || "staff"
    }));
    res.json(output);
  } catch (_error) {
    res.status(500).json({ error: "Failed to load staff" });
  }
});

app.post("/api/admin/staff", requireAdmin, async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    const password = String(req.body.password || "");
    const name = String(req.body.name || "").trim() || "Staff";
    const role = req.body.role === "owner" ? "owner" : "staff";

    if (!isValidEmail(email) || password.length < 6) {
      return res.status(400).json({ error: "Valid email and password (>= 6) are required" });
    }

    const store = await readStore();
    if (store.adminStaff.find((entry) => normalizeEmail(entry.email) === email)) {
      return res.status(409).json({ error: "Staff already exists" });
    }

    const newStaff = {
      id: Date.now(),
      email,
      name,
      role,
      passwordHash: hashSecret(password)
    };
    store.adminStaff.unshift(newStaff);
    await writeStore(store);

    return res.status(201).json({ id: newStaff.id, email: newStaff.email, name: newStaff.name, role: newStaff.role });
  } catch (_error) {
    return res.status(500).json({ error: "Failed to create staff" });
  }
});

app.delete("/api/admin/staff/:id", requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const store = await readStore();
    const target = store.adminStaff.find((entry) => Number(entry.id) === id);
    if (!target) return res.status(404).json({ error: "Staff not found" });
    if (target.role === "owner") return res.status(400).json({ error: "Owner account cannot be removed" });

    store.adminStaff = store.adminStaff.filter((entry) => Number(entry.id) !== id);
    await writeStore(store);
    return res.status(204).send();
  } catch (_error) {
    return res.status(500).json({ error: "Failed to remove staff" });
  }
});

app.get("/api/users", requireAdmin, async (_req, res) => {
  try {
    const store = await readStore();
    res.json(store.users || []);
  } catch (_error) {
    res.status(500).json({ error: "Failed to load users" });
  }
});

app.get("/api/users/:email", async (req, res) => {
  try {
    const email = normalizeEmail(req.params.email);
    const store = await readStore();
    const user = store.users.find((entry) => String(entry.email || "").toLowerCase() === email);

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    return res.json(user);
  } catch (_error) {
    return res.status(500).json({ error: "Failed to load user" });
  }
});

app.post("/api/auth/request-email-code", async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);

    if (!isValidEmail(email)) {
      return res.status(400).json({ error: "Valid email is required" });
    }

    const code = String(Math.floor(100000 + Math.random() * 900000));
    const expiresAt = Date.now() + EMAIL_CODE_TTL_MS;
    emailCodeStore.set(email, { code, expiresAt });

    const transporter = buildSmtpTransporter();
    const from = process.env.SMTP_FROM || process.env.SMTP_USER;
    await transporter.sendMail({
      from,
      to: email,
      subject: "SÉANCE verification code",
      text: `Your verification code is ${code}. It will expire in 10 minutes.`,
      html: `<p>Your verification code is <strong>${code}</strong>.</p><p>It will expire in 10 minutes.</p>`
    });

    return res.json({ ok: true, expiresInMinutes: 10 });
  } catch (error) {
    return res.status(500).json({ error: error.message || "Failed to send verification email" });
  }
});

app.post("/api/auth/verify-email-code", async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    const code = String(req.body.code || "").trim();
    const phone = String(req.body.phone || "").trim();
    const name = String(req.body.name || "").trim();
    const language = req.body.language === "zh" ? "zh" : "en";

    if (!isValidEmail(email)) {
      return res.status(400).json({ error: "Valid email is required" });
    }

    if (!code) {
      return res.status(400).json({ error: "Verification code is required" });
    }

    const record = emailCodeStore.get(email);
    if (!record) {
      return res.status(400).json({ error: "No verification code found. Please request a new code." });
    }

    if (record.expiresAt < Date.now()) {
      emailCodeStore.delete(email);
      return res.status(400).json({ error: "Verification code expired. Please request a new code." });
    }

    if (record.code !== code) {
      return res.status(400).json({ error: "Invalid verification code" });
    }

    emailCodeStore.delete(email);
    const result = await upsertUserProfile({ email, phone, name, language });
    return res.status(result.isUpdate ? 200 : 201).json(result.user);
  } catch (_error) {
    return res.status(500).json({ error: "Failed to verify email" });
  }
});

app.post("/api/users", async (_req, res) => {
  try {
    return res.status(403).json({ error: "Use /api/users/profile for Firebase sign-in profile save" });
  } catch (_error) {
    return res.status(500).json({ error: "Failed to save user" });
  }
});

app.post("/api/users/profile", async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    const phone = String(req.body.phone || "").trim();
    const name = String(req.body.name || "").trim();
    const language = req.body.language === "zh" ? "zh" : "en";

    if (!isValidEmail(email)) {
      return res.status(400).json({ error: "Valid email is required" });
    }

    const result = await upsertUserProfile({ email, phone, name, language });
    return res.status(result.isUpdate ? 200 : 201).json(result.user);
  } catch (_error) {
    return res.status(500).json({ error: "Failed to save profile" });
  }
});

/* ---------- Categories ---------- */

app.get("/api/categories", async (_req, res) => {
  try {
    const store = await readStore();
    res.json(store.categories || []);
  } catch (_error) {
    res.status(500).json({ error: "Failed to load categories" });
  }
});

app.post("/api/categories", requireAdmin, async (req, res) => {
  try {
    const nameZh = String(req.body.nameZh || "").trim();
    const nameEn = String(req.body.nameEn || "").trim();
    if (!nameZh && !nameEn) {
      return res.status(400).json({ error: "Category name is required" });
    }
    const store = await readStore();
    const category = {
      id: Date.now(),
      nameZh,
      nameEn
    };
    store.categories.unshift(category);
    await writeStore(store);
    return res.status(201).json(category);
  } catch (_error) {
    return res.status(500).json({ error: "Failed to create category" });
  }
});

app.delete("/api/categories/:id", requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const store = await readStore();
    const before = store.categories.length;
    store.categories = store.categories.filter((entry) => Number(entry.id) !== id);
    if (store.categories.length === before) {
      return res.status(404).json({ error: "Category not found" });
    }
    await writeStore(store);
    return res.status(204).send();
  } catch (_error) {
    return res.status(500).json({ error: "Failed to delete category" });
  }
});

/* ---------- Products ---------- */

app.post("/api/products", requireAdmin, async (req, res) => {
  try {
    const payload = normalizeProduct(req.body);
    if (!payload || !payload.photo || !payload.desc) {
      return res.status(400).json({ error: "Invalid product payload" });
    }

    const store = await readStore();
    payload.id = Date.now();
    store.products.unshift(payload);
    await writeStore(store);

    return res.status(201).json(payload);
  } catch (_error) {
    return res.status(500).json({ error: "Failed to create product" });
  }
});

app.put("/api/products/:id", requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const payload = normalizeProduct({ ...req.body, id });
    if (!payload || !payload.photo || !payload.desc) {
      return res.status(400).json({ error: "Invalid product payload" });
    }

    const store = await readStore();
    const index = store.products.findIndex((product) => Number(product.id) === id);
    if (index === -1) {
      return res.status(404).json({ error: "Product not found" });
    }

    store.products[index] = { ...store.products[index], ...payload, id };
    await writeStore(store);
    return res.json(store.products[index]);
  } catch (_error) {
    return res.status(500).json({ error: "Failed to update product" });
  }
});

app.delete("/api/products/:id", requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const store = await readStore();
    const before = store.products.length;

    store.products = store.products.filter((product) => Number(product.id) !== id);
    if (store.products.length === before) {
      return res.status(404).json({ error: "Product not found" });
    }

    await writeStore(store);
    return res.status(204).send();
  } catch (_error) {
    return res.status(500).json({ error: "Failed to delete product" });
  }
});

/* ---------- Orders ---------- */

app.post("/api/orders", async (req, res) => {
  try {
    const {
      items,
      paymentMethod,
      buyerNote,
      proofUrl,
      customerEmail,
      customerPhone,
      customerName,
      shippingAddress,
      couponCode
    } = req.body;

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "Order items are required" });
    }

    const store = await readStore();
    const inventoryErrors = updateInventoryFromOrder(store, items);
    if (inventoryErrors.length > 0) {
      return res.status(400).json({ error: "Some items are sold out", details: inventoryErrors });
    }

    const pricing = computeOrderPrice({
      items,
      coupons: store.coupons,
      shippingRules: store.shippingRules,
      couponCode
    });

    const newOrder = {
      id: Date.now(),
      items,
      subtotal: pricing.subtotal,
      discount: pricing.discount,
      shippingFee: pricing.shippingFee,
      total: pricing.total,
      appliedCouponCode: pricing.appliedCouponCode,
      paymentMethod: paymentMethod || "alipay",
      paymentStatus: "pending",
      status: "pending",
      buyerNote: buyerNote || "",
      proofUrl: proofUrl || "",
      customerEmail: customerEmail || "",
      customerPhone: customerPhone || "",
      customerName: customerName || "",
      shippingAddress: String(shippingAddress || "").trim(),
      trackingNumber: "",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    store.orders.unshift(newOrder);
    await writeStore(store);

    return res.status(201).json(newOrder);
  } catch (_error) {
    return res.status(500).json({ error: "Failed to create order" });
  }
});

app.patch("/api/orders/:id", requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { status, paymentStatus, buyerNote, proofUrl, trackingNumber, shippingAddress } = req.body;
    const store = await readStore();
    const order = store.orders.find((entry) => Number(entry.id) === id);

    if (!order) {
      return res.status(404).json({ error: "Order not found" });
    }

    if (status) order.status = status;
    if (paymentStatus) order.paymentStatus = paymentStatus;
    if (typeof buyerNote === "string") order.buyerNote = buyerNote;
    if (typeof proofUrl === "string") order.proofUrl = proofUrl;
    if (typeof trackingNumber === "string") order.trackingNumber = trackingNumber;
    if (typeof shippingAddress === "string") order.shippingAddress = shippingAddress;

    order.updatedAt = new Date().toISOString();

    await writeStore(store);
    return res.json(order);
  } catch (_error) {
    return res.status(500).json({ error: "Failed to update order" });
  }
});

/* ---------- Coupons ---------- */

app.post("/api/coupons", requireAdmin, async (req, res) => {
  try {
    const payload = normalizeCoupon(req.body);
    if (!payload) {
      return res.status(400).json({ error: "Invalid coupon payload" });
    }

    const store = await readStore();
    const exists = store.coupons.some((entry) => entry.code === payload.code);
    if (exists) {
      return res.status(409).json({ error: "Coupon already exists" });
    }

    store.coupons.unshift(payload);
    await writeStore(store);
    return res.status(201).json(payload);
  } catch (_error) {
    return res.status(500).json({ error: "Failed to create coupon" });
  }
});

app.put("/api/coupons/:code", requireAdmin, async (req, res) => {
  try {
    const code = String(req.params.code || "").trim().toUpperCase();
    const payload = normalizeCoupon({ ...req.body, code });
    if (!payload) {
      return res.status(400).json({ error: "Invalid coupon payload" });
    }

    const store = await readStore();
    const index = store.coupons.findIndex((entry) => entry.code === code);
    if (index === -1) {
      return res.status(404).json({ error: "Coupon not found" });
    }

    store.coupons[index] = payload;
    await writeStore(store);
    return res.json(payload);
  } catch (_error) {
    return res.status(500).json({ error: "Failed to update coupon" });
  }
});

app.delete("/api/coupons/:code", requireAdmin, async (req, res) => {
  try {
    const code = String(req.params.code || "").trim().toUpperCase();
    const store = await readStore();
    const before = store.coupons.length;

    store.coupons = store.coupons.filter((entry) => entry.code !== code);
    if (store.coupons.length === before) {
      return res.status(404).json({ error: "Coupon not found" });
    }

    await writeStore(store);
    return res.status(204).send();
  } catch (_error) {
    return res.status(500).json({ error: "Failed to delete coupon" });
  }
});

/* ---------- Shipping ---------- */

app.put("/api/shipping-rules", requireAdmin, async (req, res) => {
  try {
    const freeShippingThreshold = Number(req.body.freeShippingThreshold);
    const defaultShippingFee = Number(req.body.defaultShippingFee);

    if (!Number.isFinite(freeShippingThreshold) || !Number.isFinite(defaultShippingFee)) {
      return res.status(400).json({ error: "Invalid shipping rules" });
    }

    const store = await readStore();
    store.shippingRules = {
      freeShippingThreshold: Math.max(0, freeShippingThreshold),
      defaultShippingFee: Math.max(0, defaultShippingFee)
    };

    await writeStore(store);
    return res.json(store.shippingRules);
  } catch (_error) {
    return res.status(500).json({ error: "Failed to update shipping rules" });
  }
});

app.put("/api/payment-qr", requireAdmin, async (req, res) => {
  try {
    const { alipay, payme } = req.body;
    const store = await readStore();

    store.paymentQr = {
      alipay: alipay || store.paymentQr?.alipay,
      payme: payme || store.paymentQr?.payme
    };

    await writeStore(store);
    return res.json(store.paymentQr);
  } catch (_error) {
    return res.status(500).json({ error: "Failed to update payment QR" });
  }
});

app.post("/api/upload-image", requireAdmin, uploadImage.single("image"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "Image file is required" });
    }

    const imageUrl = `/uploads/${req.file.filename}`;
    return res.status(201).json({ imageUrl });
  } catch (_error) {
    return res.status(500).json({ error: "Failed to upload image" });
  }
});

app.use("/uploads", express.static(UPLOADS_DIR));
app.use(express.static(FRONTEND_DIR));

app.get("*", (_req, res) => {
  res.sendFile(path.join(FRONTEND_DIR, "index.html"));
});

app.listen(PORT, () => {
  console.log(`Boutique app running on http://localhost:${PORT}`);
});