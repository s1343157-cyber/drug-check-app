import express from "express";
import multer from "multer";
import OpenAI from "openai";
import xlsx from "xlsx";
import fs from "fs";
import helmet from "helmet";
import cors from "cors";
import rateLimit from "express-rate-limit";
import basicAuth from "express-basic-auth";


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

function levenshtein(a, b) {
  if (!a || !b) return 99;

  const matrix = [];

  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }

  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        );
      }
    }
  }

  return matrix[b.length][a.length];
}

function isSafeMatch(input, product, generic) {
  if (!input) return false;

  // ① 完全一致
  if (input === product || input === generic) return true;

  // ② 前方一致（3文字以上）
  if (input.length >= 3) {
    if (product.startsWith(input)) return true;
    if (generic.startsWith(input)) return true;
  }

  // ③ レーベンシュタイン距離 1以内
  if (levenshtein(input, product) <= 1) return true;
  if (levenshtein(input, generic) <= 1) return true;

  return false;
}


const app = express();

app.set("trust proxy", 1);

let activeRequests = 0;
const MAX_CONCURRENT = 3; // 同時実行上限


app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(
  basicAuth({
    users: { admin: process.env.APP_PASSWORD },
    challenge: true,
  })
);

app.use(express.static("public"));

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

function getCombinationComponents(row) {
  const components = [];

  if (row["分解後成分名①"]) {
    components.push(row["分解後成分名①"]);
  }

  if (row["分解後成分名②"]) {
    components.push(row["分解後成分名②"]);
  }

  return components;
}


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

     　 return isSafeMatch(
          normalizedInput,
          product,
          generic
        );
　　　});

      if (match) {

        const result = {
         商品名: drug
        };

        if (match["休薬期間"] != null) {
          result["休薬期間"] = match["休薬期間"];
        }

        const components = getCombinationComponents(match);

        if (components.length > 0) {
           result["配合成分"] = components;
        }

        matchedDrugs.push(result);
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

     　 return isSafeMatch(
          normalizedInput,
          product,
          generic
        );
      });

      if (match) {

        const result = {
          商品名: drug
        };

        if (match["休薬期間"] != null) {
          result["休薬期間"] = match["休薬期間"];
        }

        const components = getCombinationComponents(match);

        if (components.length > 0) {
          result["配合成分"] = components;
        }

        matchedDrugs.push(result);
      }


    return res.json({
      matchedDrugs
    });

  } catch (err) {
    console.error("再判定エラー:", err);
    return res.status(500).json({ error: "再判定失敗" });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server started on port ${PORT}`);
});
