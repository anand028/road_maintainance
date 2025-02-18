require("dotenv").config();
const express = require("express");
const multer = require("multer");
const sharp = require("sharp");
const ort = require("onnxruntime-node");
const fs = require("fs");
const path = require("path");
const { v4: uuidv4 } = require("uuid");
const mongoose = require("mongoose");
const Detection = require("./models/Detection");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { body, validationResult } = require("express-validator");
const User = require("./models/User");
const Admin = require("./models/Admin");
const auth = require("./middleware/auth");

const app = express();
const upload = multer({ dest: "uploads/" });
const targetSize = 640;
app.use(express.json());
const JWT_SECRET = process.env.JWT_SECRET;

// Connect to MongoDB
mongoose
  .connect(process.env.MONGO_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  })
  .then(() => console.log("✅ MongoDB Connected"))
  .catch((err) => console.error("❌ MongoDB Connection Error:", err));

// Load ONNX Model
let session;
(async () => {
  try {
    session = await ort.InferenceSession.create(
      path.join(__dirname, "YOLOv8_Small_RDD.onnx")
    );
    console.log("✅ ONNX Model Loaded Successfully");
  } catch (e) {
    console.error("❌ Model Loading Failed:", e);
    process.exit(1);
  }
})();

// Image Preprocessing
async function preprocessImage(imagePath) {
  const metadata = await sharp(imagePath).metadata();
  const originalWidth = metadata.width;
  const originalHeight = metadata.height;

  const scale = Math.min(
    targetSize / originalWidth,
    targetSize / originalHeight
  );
  const scaledWidth = Math.round(originalWidth * scale);
  const scaledHeight = Math.round(originalHeight * scale);

  const rawBuffer = await sharp(imagePath)
    .resize(scaledWidth, scaledHeight)
    .extend({
      top: Math.round((targetSize - scaledHeight) / 2),
      bottom:
        targetSize - scaledHeight - Math.round((targetSize - scaledHeight) / 2),
      left: Math.round((targetSize - scaledWidth) / 2),
      right:
        targetSize - scaledWidth - Math.round((targetSize - scaledWidth) / 2),
      background: { r: 0, g: 0, b: 0, alpha: 1 },
    })
    .removeAlpha()
    .raw()
    .toBuffer();

  const float32Data = new Float32Array(rawBuffer.length);
  for (let i = 0; i < rawBuffer.length; i++) {
    float32Data[i] = rawBuffer[i] / 255.0;
  }

  return { buffer: float32Data, originalWidth, originalHeight, scale };
}

// Process ONNX Detections
function processDetections(output, originalWidth, originalHeight, scale) {
  const detections = [];
  const rawData = Array.from(output.data);

  for (let i = 0; i < rawData.length; i += 6) {
    const [x_center, y_center, width, height, confidence, classId] =
      rawData.slice(i, i + 6);

    if (confidence > 0.5) {
      detections.push({
        x: ((x_center / targetSize) * originalWidth) / scale,
        y: ((y_center / targetSize) * originalHeight) / scale,
        width: ((width / targetSize) * originalWidth) / scale,
        height: ((height / targetSize) * originalHeight) / scale,
        confidence,
        classId,
      });
    }
  }
  return detections;
}

// Prediction Endpoint
app.post("/predict", upload.single("image"), async (req, res) => {
  try {
    const { buffer, originalWidth, originalHeight, scale } =
      await preprocessImage(req.file.path);
    const tensor = new ort.Tensor("float32", new Float32Array(buffer), [
      1,
      3,
      targetSize,
      targetSize,
    ]);
    const outputs = await session.run({ images: tensor });
    const output = outputs[Object.keys(outputs)[0]];

    if (!output || !output.data) throw new Error("Invalid Model Output");

    const detections = processDetections(
      output,
      originalWidth,
      originalHeight,
      scale
    );
    const imageId = uuidv4();
    const resultImagePath = path.join(__dirname, "uploads", `${imageId}.jpg`);

    // Draw Bounding Boxes
    const svg = `<svg width="${originalWidth}" height="${originalHeight}">
      ${detections
        .map(
          (d) =>
            `<rect x="${d.x}" y="${d.y}" width="${d.width}" height="${d.height}" stroke="red" fill="none" stroke-width="2"/>`
        )
        .join("")}
    </svg>`;

    await sharp(req.file.path)
      .composite([{ input: Buffer.from(svg), blend: "over" }])
      .toFile(resultImagePath);

    // Save to MongoDB
    const detectionData = await Detection.create({
      imageUrl: `http://localhost:5000/uploads/${imageId}.jpg`,
      detections,
      originalWidth,
      originalHeight,
      userId: req.body.userId, // Assuming frontend sends user ID
      status: "pending",
    });

    res.json({
      success: true,
      detectionId: detectionData._id,
      imageUrl: detectionData.imageUrl,
      detections,
    });
  } catch (error) {
    console.error("Prediction Error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to process image",
      details: error.message,
    });
  }
});

// Admin Approval Endpoint
app.put("/approve/:id", auth, async (req, res) => {
  if (req.user.role !== "admin")
    return res.status(403).json({ error: "Forbidden" });

  const detection = await Detection.findByIdAndUpdate(
    req.params.id,
    { status: "approved" },
    { new: true }
  );
  if (!detection) return res.status(404).json({ error: "Detection not found" });

  res.json({ message: "Image approved", detection });
});

// Fetch Detections for User
app.get("/detections/:userId", async (req, res) => {
  try {
    const detections = await Detection.find({ userId: req.params.userId });
    res.json({ success: true, detections });
  } catch (error) {
    res
      .status(500)
      .json({ success: false, error: "Error fetching detections" });
  }
});

app.post(
  "/register",
  [
    body("name").notEmpty(),
    body("email").isEmail(),
    body("password").isLength({ min: 6 }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty())
      return res.status(400).json({ errors: errors.array() });

    const { name, email, password } = req.body;
    try {
      let user = await User.findOne({ email });
      if (user) return res.status(400).json({ error: "User already exists" });

      // ✅ Hash Password before saving
      const salt = await bcrypt.genSalt(10);
      const hashedPassword = await bcrypt.hash(password, salt);

      user = new User({ name, email, password: hashedPassword });
      await user.save();

      // ✅ Ensure JWT_SECRET is set
      if (!JWT_SECRET) throw new Error("JWT_SECRET is missing in .env file");

      const token = jwt.sign({ id: user._id, role: "user" }, JWT_SECRET, {
        expiresIn: "1d",
      });

      res.json({
        token,
        user: { id: user._id, name: user.name, role: "user" },
      });
    } catch (error) {
      console.error("Registration Error:", error);
      res.status(500).json({ error: error.message || "Server error" });
    }
  }
);

app.post(
  "/login",
  [
    body("email").isEmail(),
    body("password").isLength({ min: 6 }),
    body("role").isIn(["user", "admin"]),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty())
      return res.status(400).json({ errors: errors.array() });

    const { email, password, role } = req.body;
    console.log("I am inside login route", { email, password, role });
    try {
      const Model = role === "admin" ? Admin : User;
      const user = await Model.findOne({ email });

      if (!user) return res.status(400).json({ error: "Invalid credentials" });

      const isMatch = await bcrypt.compare(password, user.password);
      if (!isMatch)
        return res.status(400).json({ error: "Invalid credentials" });

      const token = jwt.sign({ id: user._id, role: user.role }, JWT_SECRET, {
        expiresIn: "1d",
      });
      res.json({
        token,
        user: { id: user._id, name: user.name, role: user.role },
      });
    } catch (error) {
      res.status(500).json({ error: "Server error" });
    }
  }
);

app.post("/register-admin", async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password)
    return res.status(400).json({ error: "All fields required" });

  try {
    let admin = await Admin.findOne({ email });
    if (admin) return res.status(400).json({ error: "Admin already exists" });

    admin = new Admin({ name, email, password });
    await admin.save();

    const token = jwt.sign({ id: admin._id, role: "admin" }, JWT_SECRET, {
      expiresIn: "1d",
    });
    res.json({
      token,
      admin: { id: admin._id, name: admin.name, role: "admin" },
    });
  } catch (error) {
    res.status(500).json({ error: "Server error" });
  }
});

// Start Server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
