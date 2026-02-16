import express from "express";
import multer from "multer";
import OpenAI from "openai";
import xlsx from "xlsx";
import fs from "fs";
import helmet from "helmet";
import cors from "cors";
import rateLimit from "express-rate-limit";

// ★ ここに追加
function normalizeDrugName(name) {
  if (!name) return "";

  return name
    .replace(/\s+/g, "")
    .replace(/「.*?」/g, "")
    .replace(/[０-９]/g, s =>
      String.fromCharCode(s.charCodeAt(0) - 0xFEE0)
    )
    .toLowerCase();
}

const app = express();

let activeRequests = 0;
const MAX_CONCURRENT = 3; // 同時実行上限

app.use(express.static("public"));
app.use(express.json());
app.use(helmet());
app.use(cors());

app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100
}));

const upload = multer({
  dest: "uploads/",
  limits: { fileSize: 5 * 1024 * 1024 }
});

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

function loadExcel() {
  const workbook = xlsx.readFile("drugs.xlsx");
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  return xlsx.utils.sheet_to_json(sheet);
}

const excelData = loadExcel();

app.get("/", (req, res) => {
  res.send("Drug Check API running");
});

app.get("/test", (req, res) => {
  res.send(`
    <h2>薬剤OCRテスト</h2>
    <form action="/ocr" method="post" enctype="multipart/form-data">
      <input type="file" name="image" accept="image/*" required />
      <br><br>
      <button type="submit">送信</button>
    </form>
  `);
});

app.post("/ocr", upload.single("image"), async (req, res) => {

  if (activeRequests >= MAX_CONCURRENT) {
    return res.status(429).json({
      error: "現在混雑中です。しばらくお待ちください。"
    });
  }

  activeRequests++;  // ← ここでカウント増やす

  let filePath;

  try {
    filePath = req.file?.path;

    if (!filePath) {
      return res.status(400).json({
        error: "画像がアップロードされていません"
      });
    }

    const image = fs.readFileSync(filePath);

    const base64Image = image.toString("base64");

    const controller = new AbortController();

    const timeout = setTimeout(() => {
      controller.abort();
    }, 20000); // 20秒

    const response = await openai.responses.create({
      model: "gpt-4o",
      input: [{
        role: "user",
        content: [
          {
            type: "input_text",
            text: `
　　　　　　この画像は処方薬の明細です。

　　　　　　画像内に記載されている「薬剤名のみ」を抽出してください。

　　　　　　【重要】
　　　　　　・人名、日付、医療機関名、効用、服用方法、注意事項は除外
　　　　　　・用量（mg、錠、回数など）は除外
　　　　　　・推測は禁止
　　　　　　・画像に明確に読める薬剤名だけをそのまま出力する
　　　　　　・存在しない薬剤名を作らない

　　　　　　必ずJSON配列のみで出力してください。

　　　　　　例：
　　　　　　["アクトス","バファリン"]
　　　　　　`

          },
          {
            type: "input_image",
            image_url: `data:image/jpeg;base64,${base64Image}`
          }
        ]
      }],
    });


    clearTimeout(timeout);

    fs.unlinkSync(req.file.path);

    let ocrText =
      response.output?.[0]?.content?.[0]?.text || "";

    // GPTがつける ```json ``` を除去
    ocrText = ocrText
      .replace(/```json/g, "")
      .replace(/```/g, "")
      .trim();

　　console.log("🧠 OCR生テキスト:", ocrText);  // ←ここ追加

　　console.log(excelData);
　　console.log("🔍 Excel1行目:", excelData[0]);


    let extractedDrugs = [];
　　try {
 　　 extractedDrugs = JSON.parse(ocrText);
  　　console.log("🧠 OCR抽出:", extractedDrugs);

 　　 // 🔽 ここから改良ロジック

 　　 const validatedDrugs = extractedDrugs.filter(inputDrug => {
 　　   const normalizedInput = normalizeDrugName(inputDrug);

    　　return excelData.some(row => {
     　　 const product = normalizeDrugName(row["商品名"]);
     　　 const generic = normalizeDrugName(row["一般名"]);

     　　 return (
     　　   product.includes(normalizedInput) ||
     　　   normalizedInput.includes(product) ||
     　　   generic.includes(normalizedInput) ||
     　　   normalizedInput.includes(generic)
     　　 );
   　　 });
  　　});

  　　console.log("✅ Excel登録薬のみ:", validatedDrugs);

  　　extractedDrugs = validatedDrugs;

  　　// 🔼 ここまで改良ロジック

　　} catch (e) {

      return res.status(400).json({
        error: "OCR結果のJSON解析に失敗しました",
        raw: ocrText
      });
    }

　　console.log("🔍 Excel1行目:", excelData[0]);

    const matchedDrugs = [];

    for (const drug of extractedDrugs) {
      const normalizedInput = normalizeDrugName(drug);

      const match = excelData.find(row => {
  　　　const product = normalizeDrugName(row["商品名"]);
  	const generic = normalizeDrugName(row["一般名"]);

  	return (
    	　product.includes(normalizedInput) ||
    	　normalizedInput.includes(product) ||
    	　generic.includes(normalizedInput) ||
    	　normalizedInput.includes(generic)
  	);
　　　});

      if (match && match["休薬期間"] != null) {
        matchedDrugs.push({
          商品名: drug,
          休薬期間: match["休薬期間"]
        });
      }
    }

    return res.json({
      extractedDrugs,
      matchedDrugs
    });


  } catch (err) {
  console.error("🔥 詳細エラー:", err);

  return res.status(500).json({
    error: "OCR failed",
    detail: err.message
  });


  } finally {

    if (filePath && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    activeRequests--;  // ← ★ここ超重要

  }
});

app.post("/recheck", express.json(), (req, res) => {
  try {
    const { drugs } = req.body;

    const matchedDrugs = [];

    for (const drug of drugs) {
      const normalizedInput = normalizeDrugName(drug);

      const match = excelData.find(row => {
        const product = normalizeDrugName(row["商品名"]);
        const generic = normalizeDrugName(row["一般名"]);

        return (
          product.includes(normalizedInput) ||
          normalizedInput.includes(product) ||
          generic.includes(normalizedInput) ||
          normalizedInput.includes(generic)
        );
      });

      if (match && match["休薬期間"] != null) {
        matchedDrugs.push({
          商品名: drug,
          休薬期間: match["休薬期間"]
        });
      }
    }

    return res.json({
      matchedDrugs
    });

  } catch (err) {
    console.error("再判定エラー:", err);
    return res.status(500).json({ error: "再判定失敗" });
  }
});

app.listen(3000, () => {
  console.log("Server started on port 3000");
});
