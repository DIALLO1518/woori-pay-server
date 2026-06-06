import express, { Request, Response } from "express";
import cors from "cors";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const prisma = new PrismaClient();

app.use(cors());
app.use(express.json());

// --- EXCHANGE RATES ---------------------------------------------------------
// Devises supportees : GNF, XOF, EUR, GBP, CHF, USD, CAD
// Matrice complete : chaque paire dans les deux sens

const EXCHANGE_RATES: Record<string, Record<string, number>> = {
  EUR: {
    EUR: 1,
    GNF: 9350,
    XOF: 655.96,
    GBP: 0.856,
    CHF: 0.963,
    USD: 1.085,
    CAD: 1.47,
  },
  GNF: {
    GNF: 1,
    EUR: 0.00011,
    XOF: 0.07,
    GBP: 0.000091,
    CHF: 0.000104,
    USD: 0.000116,
    CAD: 0.000157,
  },
  XOF: {
    XOF: 1,
    EUR: 0.0015,
    GNF: 14.25,
    GBP: 0.00131,
    CHF: 0.00147,
    USD: 0.00165,
    CAD: 0.00224,
  },
  GBP: {
    GBP: 1,
    EUR: 1.168,
    GNF: 11000,
    XOF: 766.5,
    CHF: 1.125,
    USD: 1.268,
    CAD: 1.717,
  },
  CHF: {
    CHF: 1,
    EUR: 1.038,
    GNF: 9600,
    XOF: 681.0,
    GBP: 0.889,
    USD: 1.127,
    CAD: 1.526,
  },
  USD: {
    USD: 1,
    EUR: 0.922,
    GNF: 8600,
    XOF: 605,
    GBP: 0.788,
    CHF: 0.887,
    CAD: 1.355,
  },
  CAD: {
    CAD: 1,
    EUR: 0.680,
    GNF: 6344,
    XOF: 446.6,
    GBP: 0.582,
    CHF: 0.655,
    USD: 0.738,
  },
};

const getExchangeRate = (fromCurrency: string, toCurrency: string): number => {
  if (fromCurrency === toCurrency) return 1;
  const rate = EXCHANGE_RATES[fromCurrency]?.[toCurrency];
  if (!rate) {
    console.warn(`Taux introuvable: ${fromCurrency} -> ${toCurrency}, fallback 1`);
    return 1;
  }
  return rate;
};

// --- HELPERS ----------------------------------------------------------------

const formatPhone = (phone: string): string => {
  phone = phone.replace(/\s/g, "").replace(/-/g, "");
  if (phone.startsWith("00")) phone = "+" + phone.substring(2);
  if (!phone.startsWith("+")) phone = "+225" + phone;
  return phone;
};

const generateOTP = (): string => Math.floor(100000 + Math.random() * 900000).toString();

const generateToken = (userId: string, phone: string): string =>
  jwt.sign({ userId, phone }, process.env.JWT_SECRET as string, { expiresIn: "7d" });

const authenticateToken = (req: Request, res: Response, next: any) => {
  const token = req.headers["authorization"]?.split(" ")[1];
  if (!token) return res.status(401).json({ success: false, error: "Token manquant" });
  jwt.verify(token, process.env.JWT_SECRET as string, (err: any, user: any) => {
    if (err) return res.status(403).json({ success: false, error: "Token invalide" });
    (req as any).user = user;
    next();
  });
};

const verifyPin = async (userId: string, pin: string): Promise<boolean> => {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return false;
  return bcrypt.compare(pin, user.pinHash);
};

// --- AUTH --------------------------------------------------------------------

app.post("/api/v1/auth/send-otp", async (req: Request, res: Response) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ success: false, error: "Numero requis" });

    const formattedPhone = formatPhone(phone);
    const otpCode = generateOTP();
    const expiresAt = new Date(Date.now() + 3 * 60 * 1000);

    await prisma.oTP.deleteMany({ where: { phone: formattedPhone } });
    await prisma.oTP.create({ data: { phone: formattedPhone, code: otpCode, expiresAt } });

    console.log(`OTP pour ${formattedPhone}: ${otpCode}`);

    res.json({ success: true, message: "OTP envoye", code: otpCode, expiresIn: 180 });
  } catch (error) {
    console.error("Send OTP error:", error);
    res.status(500).json({ success: false, error: "Erreur serveur" });
  }
});

app.post("/api/v1/auth/verify-otp", async (req: Request, res: Response) => {
  try {
    const { phone, otp, pin } = req.body;
    if (!phone || !otp || !pin) return res.status(400).json({ success: false, error: "Tous les champs sont requis" });
    if (!/^\d{4}$/.test(pin)) return res.status(400).json({ success: false, error: "PIN doit etre 4 chiffres" });

    const formattedPhone = formatPhone(phone);

    const otpRecord = await prisma.oTP.findFirst({
      where: { phone: formattedPhone, code: otp, verified: false, expiresAt: { gt: new Date() } }
    });

    if (!otpRecord) return res.status(400).json({ success: false, error: "Code invalide ou expire" });

    await prisma.oTP.delete({ where: { id: otpRecord.id } });

    let user = await prisma.user.findUnique({ where: { phone: formattedPhone }, include: { wallet: true } });

    if (!user) {
      user = await prisma.user.create({
        data: {
          phone: formattedPhone,
          pinHash: await bcrypt.hash(pin, 10),
          status: "ACTIVE",
          wallet: { create: { balance: 0 } }
        },
        include: { wallet: true }
      });
      console.log(`Nouveau compte cree: ${formattedPhone}`);
    } else {
      await prisma.user.update({
        where: { id: user.id },
        data: { pinHash: await bcrypt.hash(pin, 10) }
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
  } catch (error) {
    console.error("Verify OTP error:", error);
    res.status(500).json({ success: false, error: "Erreur serveur" });
  }
});

// --- WALLET ------------------------------------------------------------------

app.get("/api/v1/wallet/balance", authenticateToken, async (req: Request, res: Response) => {
  try {
    const { userId } = (req as any).user;
    const wallet = await prisma.wallet.findUnique({ where: { userId } });
    if (!wallet) return res.status(404).json({ success: false, error: "Wallet non trouve" });
    res.json({ success: true, balance: wallet.balance, currency: wallet.currency });
  } catch (error) {
    res.status(500).json({ success: false, error: "Erreur serveur" });
  }
});

// --- TRANSACTIONS -------------------------------------------------------------

app.get("/api/v1/transactions", authenticateToken, async (req: Request, res: Response) => {
  try {
    const { userId } = (req as any).user;
    const wallet = await prisma.wallet.findUnique({ where: { userId } });
    if (!wallet) return res.status(404).json({ success: false, error: "Wallet non trouve" });

    const transactions = await prisma.transaction.findMany({
      where: { walletId: wallet.id },
      orderBy: { createdAt: "desc" },
      take: 50
    });

    res.json({ success: true, transactions });
  } catch (error) {
    res.status(500).json({ success: false, error: "Erreur serveur" });
  }
});

// --- CHECK PHONE --------------------------------------------------------------

app.get("/api/v1/users/check-phone/:phone", async (req: Request, res: Response) => {
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
  } catch (error) {
    res.status(500).json({ success: false, error: "Erreur serveur" });
  }
});

// --- DEPOSIT ------------------------------------------------------------------

app.post("/api/v1/payments/deposit", authenticateToken, async (req: Request, res: Response) => {
  try {
    const { userId } = (req as any).user;
    const { amount, currency, provider, phoneNumber, pin } = req.body;

    if (!amount || !pin) return res.status(400).json({ success: false, error: "Montant et PIN requis" });
    if (amount < 1000) return res.status(400).json({ success: false, error: "Montant minimum: 1,000" });

    const pinOk = await verifyPin(userId, pin);
    if (!pinOk) return res.status(401).json({ success: false, error: "PIN incorrect" });

    const wallet = await prisma.wallet.findUnique({ where: { userId } });
    if (!wallet) return res.status(404).json({ success: false, error: "Wallet non trouve" });

    const reference = "DEP_" + Date.now() + "_" + userId.substring(0, 6);

    const result = await prisma.$transaction(async (tx: any) => {
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
          description: `Depot via ${provider || "Mobile Money"}`,
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
        description: `Depot via ${provider || "Mobile Money"}`,
        fees: 0
      }
    });
  } catch (error) {
    console.error("Deposit error:", error);
    res.status(500).json({ success: false, error: "Erreur serveur" });
  }
});

// --- WITHDRAW -----------------------------------------------------------------

app.post("/api/v1/payments/withdraw", authenticateToken, async (req: Request, res: Response) => {
  try {
    const { userId } = (req as any).user;
    const { amount, currency, provider, phoneNumber, pin } = req.body;

    if (!amount || !pin) return res.status(400).json({ success: false, error: "Montant et PIN requis" });
    if (amount < 5000) return res.status(400).json({ success: false, error: "Montant minimum: 5,000" });

    const pinOk = await verifyPin(userId, pin);
    if (!pinOk) return res.status(401).json({ success: false, error: "PIN incorrect" });

    const wallet = await prisma.wallet.findUnique({ where: { userId } });
    if (!wallet) return res.status(404).json({ success: false, error: "Wallet non trouve" });
    if (wallet.balance < amount) return res.status(400).json({ success: false, error: "Solde insuffisant" });

    const reference = "WIT_" + Date.now() + "_" + userId.substring(0, 6);

    const result = await prisma.$transaction(async (tx: any) => {
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
  } catch (error) {
    console.error("Withdraw error:", error);
    res.status(500).json({ success: false, error: "Erreur serveur" });
  }
});

// --- TRANSFER -----------------------------------------------------------------

app.post("/api/v1/transfers/send", authenticateToken, async (req: Request, res: Response) => {
  try {
    const { userId } = (req as any).user;
    const { recipientPhone, recipientName, amount, currency, pin } = req.body;

    if (!recipientPhone || !amount || !pin) {
      return res.status(400).json({ success: false, error: "Tous les champs requis" });
    }

    const pinOk = await verifyPin(userId, pin);
    if (!pinOk) return res.status(401).json({ success: false, error: "PIN incorrect" });

    const formattedRecipient = formatPhone(recipientPhone);

    const recipient = await prisma.user.findUnique({
      where: { phone: formattedRecipient },
      include: { wallet: true }
    });

    if (!recipient || recipient.status === "PENDING" || !recipient.wallet) {
      return res.status(404).json({ success: false, error: "Ce numero n'a pas de compte Woori Pay actif" });
    }

    const senderWallet = await prisma.wallet.findUnique({ where: { userId } });
    if (!senderWallet) return res.status(404).json({ success: false, error: "Wallet expediteur non trouve" });

    const fee = amount >= 100000 ? Math.floor(amount * 0.01) : 0;
    const totalDebit = amount + fee;

    if (senderWallet.balance < totalDebit) {
      return res.status(400).json({ success: false, error: "Solde insuffisant (frais inclus)" });
    }

    const senderCurrency = senderWallet.currency;
    const recipientCurrency = recipient.wallet.currency;
    const rate = getExchangeRate(senderCurrency, recipientCurrency);
    const amountToCredit = Math.floor(amount * rate);

    const reference = "TRF_" + Date.now() + "_" + userId.substring(0, 6);

    const result = await prisma.$transaction(async (tx: any) => {
      await tx.wallet.update({
        where: { id: senderWallet.id },
        data: { balance: { decrement: totalDebit } }
      });

      await tx.wallet.update({
        where: { id: recipient.wallet!.id },
        data: { balance: { increment: amountToCredit } }
      });

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
          netAmount: amountToCredit,
          reference,
          description: `Envoye a ${recipientName || formattedRecipient}`,
          completedAt: new Date()
        }
      });

      return transaction;
    });

    res.json({
      success: true,
      transactionId: result.id,
      rate,
      amountToCredit,
      senderCurrency,
      recipientCurrency,
      transaction: {
        id: result.id,
        type: "TRANSFER_SENT",
        amount: -amount,
        currency: senderCurrency,
        date: result.createdAt,
        status: "COMPLETED",
        description: `Envoye a ${recipientName || formattedRecipient}`,
        recipientName: recipientName || "Utilisateur Woori",
        recipientPhone: formattedRecipient,
        fees: fee,
        rate,
        convertedAmount: amountToCredit,
        recipientCurrency
      }
    });
  } catch (error) {
    console.error("Transfer error:", error);
    res.status(500).json({ success: false, error: "Erreur serveur" });
  }
});

// --- HEALTH ------------------------------------------------------------------

app.get("/health", (req: Request, res: Response) => {
  res.json({ status: "OK", timestamp: new Date().toISOString() });
});

// --- ADMIN -------------------------------------------------------------------

app.get("/admin", (req: Request, res: Response) => {
  res.sendFile(require("path").join(process.cwd(), "dist", "admin.html"));
});

app.get("/api/v1/admin/stats", async (req: Request, res: Response) => {
  try {
    const totalUsers = await prisma.user.count();
    const totalTx = await prisma.transaction.count();
    const fees = await prisma.transaction.aggregate({ _sum: { fee: true } });
    const volume = await prisma.transaction.aggregate({ _sum: { amount: true } });
    const byType = await prisma.transaction.groupBy({ by: ["type"], _count: { id: true } });
    const newUsersToday = await prisma.user.count({
      where: { createdAt: { gte: new Date(new Date().setHours(0, 0, 0, 0)) } }
    });
    res.json({
      success: true,
      totalUsers,
      totalTransactions: totalTx,
      totalVolume: volume._sum.amount || 0,
      totalFees: fees._sum.fee || 0,
      activeCountries: 18,
      newUsersToday,
      byType: Object.fromEntries(byType.map((b) => [b.type, b._count.id]))
    });
  } catch (e) {
    res.status(500).json({ error: "Erreur" });
  }
});

app.get("/api/v1/admin/users", async (req: Request, res: Response) => {
  try {
    const users = await prisma.user.findMany({
      include: { wallet: true },
      orderBy: { createdAt: "desc" },
      take: 100
    });
    res.json({ success: true, users });
  } catch (e) {
    res.status(500).json({ error: "Erreur" });
  }
});

app.get("/api/v1/admin/transactions", async (req: Request, res: Response) => {
  try {
    const transactions = await prisma.transaction.findMany({
      include: { sender: { select: { phone: true, firstName: true, lastName: true } } },
      orderBy: { createdAt: "desc" },
      take: 200
    });
    res.json({ success: true, transactions });
  } catch (e) {
    res.status(500).json({ error: "Erreur" });
  }
});

app.get("/api/v1/admin/countries", async (req: Request, res: Response) => {
  try {
    const countries = [
      { code: "GN",  name: "Guinee",        currency: "GNF", dial: "+224" },
      { code: "CI",  name: "Cote d'Ivoire", currency: "XOF", dial: "+225" },
      { code: "SN",  name: "Senegal",       currency: "XOF", dial: "+221" },
      { code: "ML",  name: "Mali",          currency: "XOF", dial: "+223" },
      { code: "BF",  name: "Burkina Faso",  currency: "XOF", dial: "+226" },
      { code: "TG",  name: "Togo",          currency: "XOF", dial: "+228" },
      { code: "BJ",  name: "Benin",         currency: "XOF", dial: "+229" },
      { code: "FR",  name: "France",        currency: "EUR", dial: "+33"  },
      { code: "BE",  name: "Belgique",      currency: "EUR", dial: "+32"  },
      { code: "DE",  name: "Allemagne",     currency: "EUR", dial: "+49"  },
      { code: "IT",  name: "Italie",        currency: "EUR", dial: "+39"  },
      { code: "ES",  name: "Espagne",       currency: "EUR", dial: "+34"  },
      { code: "PT",  name: "Portugal",      currency: "EUR", dial: "+351" },
      { code: "NL",  name: "Pays-Bas",      currency: "EUR", dial: "+31"  },
      { code: "GB",  name: "Royaume-Uni",   currency: "GBP", dial: "+44"  },
      { code: "CH",  name: "Suisse",        currency: "CHF", dial: "+41"  },
      { code: "US",  name: "Etats-Unis",    currency: "USD", dial: "+1"   },
      { code: "CA",  name: "Canada",        currency: "CAD", dial: "+1"   }
    ];
    const results = await Promise.all(
      countries.map(async (c) => {
        const userCount = await prisma.user.count({ where: { phone: { startsWith: c.dial } } });
        const txData = await prisma.transaction.aggregate({
          where: { sender: { phone: { startsWith: c.dial } } },
          _sum: { amount: true, fee: true }
        });
        return { ...c, userCount, volume: txData._sum.amount || 0, fees: txData._sum.fee || 0 };
      })
    );
    res.json({ success: true, countries: results });
  } catch (e) {
    res.status(500).json({ error: "Erreur" });
  }
});

// --- START -------------------------------------------------------------------

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Woori Pay Server demarre sur le port ${PORT}`);
  console.log(`Test: http://localhost:${PORT}/health`);
});

process.on("SIGINT", async () => {
  await prisma.$disconnect();
  process.exit(0);
});