"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const client_1 = require("@prisma/client");
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
const app = (0, express_1.default)();
const prisma = new client_1.PrismaClient();
app.use((0, cors_1.default)());
app.use(express_1.default.json());
// --- HELPERS ----------------------------------------------------------------
const formatPhone = (phone) => {
    phone = phone.replace(/\s/g, "").replace(/-/g, "");
    if (phone.startsWith("00"))
        phone = "+" + phone.substring(2);
    if (!phone.startsWith("+"))
        phone = "+225" + phone;
    return phone;
};
const generateOTP = () => Math.floor(100000 + Math.random() * 900000).toString();
const generateToken = (userId, phone) => jsonwebtoken_1.default.sign({ userId, phone }, process.env.JWT_SECRET, { expiresIn: "7d" });
const authenticateToken = (req, res, next) => {
    const token = req.headers["authorization"]?.split(" ")[1];
    if (!token)
        return res.status(401).json({ success: false, error: "Token manquant" });
    jsonwebtoken_1.default.verify(token, process.env.JWT_SECRET, (err, user) => {
        if (err)
            return res.status(403).json({ success: false, error: "Token invalide" });
        req.user = user;
        next();
    });
};
const verifyPin = async (userId, pin) => {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user)
        return false;
    return bcryptjs_1.default.compare(pin, user.pinHash);
};
// --- AUTH --------------------------------------------------------------------
app.post("/api/v1/auth/send-otp", async (req, res) => {
    try {
        const { phone } = req.body;
        if (!phone)
            return res.status(400).json({ success: false, error: "Num�ro requis" });
        const formattedPhone = formatPhone(phone);
        const otpCode = generateOTP();
        const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 min
        await prisma.oTP.deleteMany({ where: { phone: formattedPhone } });
        await prisma.oTP.create({ data: { phone: formattedPhone, code: otpCode, expiresAt } });
        console.log(`? OTP pour ${formattedPhone}: ${otpCode}`);
        res.json({ success: true, message: "OTP envoy�", code: otpCode, expiresIn: 600 });
    }
    catch (error) {
        console.error("Send OTP error:", error);
        res.status(500).json({ success: false, error: "Erreur serveur" });
    }
});
app.post("/api/v1/auth/verify-otp", async (req, res) => {
    try {
        const { phone, otp, pin } = req.body;
        if (!phone || !otp || !pin)
            return res.status(400).json({ success: false, error: "Tous les champs sont requis" });
        if (!/^\d{4}$/.test(pin))
            return res.status(400).json({ success: false, error: "PIN doit �tre 4 chiffres" });
        const formattedPhone = formatPhone(phone);
        const otpRecord = await prisma.oTP.findFirst({
            where: { phone: formattedPhone, code: otp, verified: false, expiresAt: { gt: new Date() } }
        });
        if (!otpRecord)
            return res.status(400).json({ success: false, error: "Code invalide ou expir�" });
        await prisma.oTP.update({ where: { id: otpRecord.id }, data: { verified: true } });
        let user = await prisma.user.findUnique({ where: { phone: formattedPhone }, include: { wallet: true } });
        if (!user) {
            // Nouveau compte � solde 0
            user = await prisma.user.create({
                data: {
                    phone: formattedPhone,
                    pinHash: await bcryptjs_1.default.hash(pin, 10),
                    status: "ACTIVE",
                    wallet: { create: { balance: 0 } }
                },
                include: { wallet: true }
            });
            console.log(`?? Nouveau compte cr��: ${formattedPhone}`);
        }
        else {
            // Compte existant � mettre � jour le PIN si reconnexion
            await prisma.user.update({
                where: { id: user.id },
                data: { pinHash: await bcryptjs_1.default.hash(pin, 10) }
            });
        }
        const token = generateToken(user.id, user.phone);
        res.json({
            success: true,
            token,
            user: {
                id: user.id,
                phone: user.phone,
                name: user.firstName ? `${user.firstName} ${user.lastName || ""}`.trim() : "Utilisateur",
                status: user.status,
                wallet: { balance: user.wallet?.balance || 0, currency: user.wallet?.currency || "XOF" }
            }
        });
    }
    catch (error) {
        console.error("Verify OTP error:", error);
        res.status(500).json({ success: false, error: "Erreur serveur" });
    }
});
// --- WALLET ------------------------------------------------------------------
app.get("/api/v1/wallet/balance", authenticateToken, async (req, res) => {
    try {
        const { userId } = req.user;
        const wallet = await prisma.wallet.findUnique({ where: { userId } });
        if (!wallet)
            return res.status(404).json({ success: false, error: "Wallet non trouv�" });
        res.json({ success: true, balance: wallet.balance, currency: wallet.currency });
    }
    catch (error) {
        res.status(500).json({ success: false, error: "Erreur serveur" });
    }
});
// --- TRANSACTIONS -------------------------------------------------------------
app.get("/api/v1/transactions", authenticateToken, async (req, res) => {
    try {
        const { userId } = req.user;
        const wallet = await prisma.wallet.findUnique({ where: { userId } });
        if (!wallet)
            return res.status(404).json({ success: false, error: "Wallet non trouv�" });
        const transactions = await prisma.transaction.findMany({
            where: { walletId: wallet.id },
            orderBy: { createdAt: "desc" },
            take: 50
        });
        res.json({ success: true, transactions });
    }
    catch (error) {
        res.status(500).json({ success: false, error: "Erreur serveur" });
    }
});
// --- CHECK PHONE --------------------------------------------------------------
app.get("/api/v1/users/check-phone/:phone", authenticateToken, async (req, res) => {
    try {
        const phone = formatPhone(decodeURIComponent(req.params.phone));
        const user = await prisma.user.findUnique({
            where: { phone },
            select: { id: true, phone: true, firstName: true, lastName: true, status: true }
        });
        if (!user || user.status === "PENDING") {
            return res.json({ success: true, exists: false });
        }
        res.json({
            success: true,
            exists: true,
            user: {
                phone: user.phone,
                name: user.firstName ? `${user.firstName} ${user.lastName || ""}`.trim() : "Utilisateur Woori"
            }
        });
    }
    catch (error) {
        res.status(500).json({ success: false, error: "Erreur serveur" });
    }
});
// --- DEPOSIT ------------------------------------------------------------------
app.post("/api/v1/payments/deposit", authenticateToken, async (req, res) => {
    try {
        const { userId } = req.user;
        const { amount, currency, provider, phoneNumber, pin } = req.body;
        if (!amount || !pin)
            return res.status(400).json({ success: false, error: "Montant et PIN requis" });
        if (amount < 1000)
            return res.status(400).json({ success: false, error: "Montant minimum: 1,000" });
        const pinOk = await verifyPin(userId, pin);
        if (!pinOk)
            return res.status(401).json({ success: false, error: "PIN incorrect" });
        const wallet = await prisma.wallet.findUnique({ where: { userId } });
        if (!wallet)
            return res.status(404).json({ success: false, error: "Wallet non trouv�" });
        const reference = "DEP_" + Date.now() + "_" + userId.substring(0, 6);
        const result = await prisma.$transaction(async (tx) => {
            const updatedWallet = await tx.wallet.update({
                where: { id: wallet.id },
                data: { balance: { increment: amount } }
            });
            const transaction = await tx.transaction.create({
                data: {
                    type: "DEPOSIT",
                    status: "COMPLETED",
                    walletId: wallet.id,
                    senderId: userId,
                    amount,
                    fee: 0,
                    netAmount: amount,
                    reference,
                    description: `D�p�t via ${provider || "Mobile Money"}`,
                    completedAt: new Date()
                }
            });
            return { transaction, newBalance: updatedWallet.balance };
        });
        res.json({
            success: true,
            newBalance: result.newBalance,
            transaction: {
                id: result.transaction.id,
                type: "DEPOSIT",
                amount,
                currency: currency || wallet.currency,
                date: result.transaction.createdAt,
                status: "COMPLETED",
                description: `D�p�t via ${provider || "Mobile Money"}`,
                fees: 0
            }
        });
    }
    catch (error) {
        console.error("Deposit error:", error);
        res.status(500).json({ success: false, error: "Erreur serveur" });
    }
});
// --- WITHDRAW -----------------------------------------------------------------
app.post("/api/v1/payments/withdraw", authenticateToken, async (req, res) => {
    try {
        const { userId } = req.user;
        const { amount, currency, provider, phoneNumber, pin } = req.body;
        if (!amount || !pin)
            return res.status(400).json({ success: false, error: "Montant et PIN requis" });
        if (amount < 5000)
            return res.status(400).json({ success: false, error: "Montant minimum: 5,000" });
        const pinOk = await verifyPin(userId, pin);
        if (!pinOk)
            return res.status(401).json({ success: false, error: "PIN incorrect" });
        const wallet = await prisma.wallet.findUnique({ where: { userId } });
        if (!wallet)
            return res.status(404).json({ success: false, error: "Wallet non trouv�" });
        if (wallet.balance < amount)
            return res.status(400).json({ success: false, error: "Solde insuffisant" });
        const reference = "WIT_" + Date.now() + "_" + userId.substring(0, 6);
        const result = await prisma.$transaction(async (tx) => {
            const updatedWallet = await tx.wallet.update({
                where: { id: wallet.id },
                data: { balance: { decrement: amount } }
            });
            const transaction = await tx.transaction.create({
                data: {
                    type: "WITHDRAWAL",
                    status: "COMPLETED",
                    walletId: wallet.id,
                    senderId: userId,
                    receiverPhone: phoneNumber,
                    amount,
                    fee: 0,
                    netAmount: amount,
                    reference,
                    description: `Retrait via ${provider || "Mobile Money"}`,
                    completedAt: new Date()
                }
            });
            return { transaction, newBalance: updatedWallet.balance };
        });
        res.json({
            success: true,
            newBalance: result.newBalance,
            transaction: {
                id: result.transaction.id,
                type: "WITHDRAWAL",
                amount: -amount,
                currency: currency || wallet.currency,
                date: result.transaction.createdAt,
                status: "COMPLETED",
                description: `Retrait via ${provider || "Mobile Money"}`,
                recipientPhone: phoneNumber,
                fees: 0
            }
        });
    }
    catch (error) {
        console.error("Withdraw error:", error);
        res.status(500).json({ success: false, error: "Erreur serveur" });
    }
});
// --- TRANSFER -----------------------------------------------------------------
app.post("/api/v1/transfers/send", authenticateToken, async (req, res) => {
    try {
        const { userId } = req.user;
        const { recipientPhone, recipientName, amount, currency, pin } = req.body;
        if (!recipientPhone || !amount || !pin)
            return res.status(400).json({ success: false, error: "Tous les champs requis" });
        const pinOk = await verifyPin(userId, pin);
        if (!pinOk)
            return res.status(401).json({ success: false, error: "PIN incorrect" });
        const formattedRecipient = formatPhone(recipientPhone);
        // V�rifier que le destinataire a un compte actif
        const recipient = await prisma.user.findUnique({
            where: { phone: formattedRecipient },
            include: { wallet: true }
        });
        if (!recipient || recipient.status === "PENDING" || !recipient.wallet) {
            return res.status(404).json({ success: false, error: "Ce num�ro n'a pas de compte Woori Pay actif" });
        }
        const senderWallet = await prisma.wallet.findUnique({ where: { userId } });
        if (!senderWallet)
            return res.status(404).json({ success: false, error: "Wallet non trouv�" });
        if (senderWallet.balance < amount)
            return res.status(400).json({ success: false, error: "Solde insuffisant" });
        const fee = amount >= 100000 ? Math.floor(amount * 0.01) : 0;
        const totalDebit = amount + fee;
        if (senderWallet.balance < totalDebit)
            return res.status(400).json({ success: false, error: "Solde insuffisant (frais inclus)" });
        const reference = "TRF_" + Date.now() + "_" + userId.substring(0, 6);
        const result = await prisma.$transaction(async (tx) => {
            await tx.wallet.update({ where: { id: senderWallet.id }, data: { balance: { decrement: totalDebit } } });
            await tx.wallet.update({ where: { id: recipient.wallet.id }, data: { balance: { increment: amount } } });
            const transaction = await tx.transaction.create({
                data: {
                    type: "TRANSFER",
                    status: "COMPLETED",
                    walletId: senderWallet.id,
                    senderId: userId,
                    receiverId: recipient.id,
                    receiverPhone: formattedRecipient,
                    amount,
                    fee,
                    netAmount: amount,
                    reference,
                    description: `Envoy� � ${recipientName || formattedRecipient}`,
                    completedAt: new Date()
                }
            });
            return transaction;
        });
        res.json({
            success: true,
            transactionId: result.id,
            transaction: {
                id: result.id,
                type: "TRANSFER_SENT",
                amount: -amount,
                currency: currency || senderWallet.currency,
                date: result.createdAt,
                status: "COMPLETED",
                description: `Envoy� � ${recipientName || formattedRecipient}`,
                recipientName: recipientName || "Utilisateur Woori",
                recipientPhone: formattedRecipient,
                fees: fee
            }
        });
    }
    catch (error) {
        console.error("Transfer error:", error);
        res.status(500).json({ success: false, error: "Erreur serveur" });
    }
});
// --- HEALTH ------------------------------------------------------------------
app.get("/health", (req, res) => {
    res.json({ status: "OK", timestamp: new Date().toISOString() });
});
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`?? Woori Pay Server d�marr� sur le port ${PORT}`);
    console.log(`?? Test: http://localhost:${PORT}/health`);
});
process.on("SIGINT", async () => {
    await prisma.$disconnect();
    process.exit(0);
});
//# sourceMappingURL=server.js.map