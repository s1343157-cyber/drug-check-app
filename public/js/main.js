

  let selectedFiles = [];

  function handleFileSelect(event) {
    const files = Array.from(event.target.files);
    selectedFiles.push(...files);
    renderPreview();
  }

  function renderPreview() {
    const previewContainer = document.getElementById("previewContainer");
    previewContainer.innerHTML = "";
    previewContainer.className = "preview-wrapper";

    selectedFiles.forEach((file, index) => {
      const reader = new FileReader();

      reader.onload = function(e) {
        const wrapper = document.createElement("div");
        wrapper.style.position = "relative";

        const img = document.createElement("img");
        img.src = e.target.result;
        img.className = "preview-img";

        const delBtn = document.createElement("button");
        delBtn.innerText = "×";
        delBtn.style.position = "absolute";
        delBtn.style.top = "6px";
        delBtn.style.right = "6px";
        delBtn.style.background = "#b02a37";
        delBtn.style.color = "white";
        delBtn.style.border = "none";
        delBtn.style.borderRadius = "6px";
        delBtn.style.padding = "4px 8px";
	delBtn.style.fontSize = "20px";
	delBtn.style.cursor = "pointer";
	delBtn.style.opacity = "0.9";
	delBtn.style.transition = "0.2s ease";

	delBtn.onmouseenter = () => {
 	  delBtn.style.background = "#c82333";
	};

	delBtn.onmouseleave = () => {
  	  delBtn.style.background = "#b02a37";
	};

        delBtn.onclick = () => removeImage(index);

        wrapper.appendChild(img);
        wrapper.appendChild(delBtn);
        previewContainer.appendChild(wrapper);
      };

      reader.readAsDataURL(file);
    });
  }

  function removeImage(index) {
    selectedFiles.splice(index, 1);
    renderPreview();
  }

  async function uploadImage() {

    if (!selectedFiles.length) {
      alert("画像を選択してください");
      return;
    }

    const buttons = document.querySelectorAll("button");
    buttons.forEach(btn => btn.disabled = true);

    document.getElementById("result").innerHTML = "<div>解析中です…</div>";

    const requests = selectedFiles.map(file => {
      const formData = new FormData();
      formData.append("image", file);

      return fetch("/ocr", {
        method: "POST",
        body: formData
      }).then(res => res.json());
    });

    let responses;

    try {
      responses = await Promise.all(requests);
    } catch (err) {
      console.error("OCRエラー:", err);
      document.getElementById("result").innerHTML =
        "OCR処理でエラーが発生しました。";

      buttons.forEach(btn => btn.disabled = false);
      return;
    }

    buttons.forEach(btn => btn.disabled = false);

    let allExtracted = [];
    let allMatched = [];

    responses.forEach(data => {
      if (data.extractedDrugs)
        allExtracted.push(...data.extractedDrugs);

      if (data.matchedDrugs)
        allMatched.push(...data.matchedDrugs);
    });

    const uniqueExtracted = [...new Set(allExtracted)];

    document.getElementById("ocrSection").style.display = "block";
    document.getElementById("ocrEditBox").value =
      uniqueExtracted.join("\n");

    const uniqueMatched = [];
    const seen = new Set();

    for (const drug of allMatched) {
      const key = drug.商品名 + drug.休薬期間;
      if (!seen.has(key)) {
        seen.add(key);
        uniqueMatched.push(drug);
      }
    }

    displayResults(uniqueMatched);
  }

  function recheckDrugs() {
    const text = document.getElementById("ocrEditBox").value;

    if (!text.trim()) {
      alert("テキストが空です");
      return;
    }

    // 1行ずつ配列に
    const drugs = text
      .split("\n")
      .map(d => d.trim())
      .filter(d => d !== "");

    // サーバーへ再判定リクエスト
    fetch("/recheck", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ drugs })
    })
       .then(res => res.json())
       .then(data => {
        displayResults(data.matchedDrugs || []);
      })
       .catch(err => {
        console.error("再判定エラー:", err);
        document.getElementById("result").innerHTML =
          "再判定でエラーが発生しました。";
      });
  }

  function displayResults(uniqueMatched) {
  
    if (!uniqueMatched || uniqueMatched.length === 0) {
      document.getElementById("result").innerHTML =
        "<div class='safe'>✔ 休薬が推奨されている薬剤はありません。</div>";
      return;
    }

    let html = "<div class='warning-title'>⚠ 休薬推奨薬剤</div>";

    uniqueMatched.forEach(drug => {
      html += `
        <div class="card">
          ${drug.商品名}は${drug.休薬期間}より休薬が推奨されています。
        </div>
      `;
    });

    document.getElementById("result").innerHTML = html;
  }

// ---- ボタンイベント登録 ----

document.addEventListener("DOMContentLoaded", function () {

  function isMobile() {
    return /iPhone|Android.+Mobile/.test(navigator.userAgent);
  }

  const cameraInput = document.getElementById("cameraInput");
  const fileInput = document.getElementById("fileInput");

  const cameraBtn = document.getElementById("cameraBtn");
  const selectImageBtn = document.getElementById("selectImageBtn");
  const analyzeBtn = document.getElementById("analyzeBtn");
  const recheckBtn = document.getElementById("recheckBtn");

  // 🔹 ファイル選択時の処理
  if (cameraInput) {
    cameraInput.addEventListener("change", handleFileSelect);
  }

  if (fileInput) {
    fileInput.addEventListener("change", handleFileSelect);
  }

  // 🔹 PCならカメラボタンを無効化
  if (!isMobile() && cameraBtn) {
    cameraBtn.disabled = true;
  }

  // 📸 カメラボタン
  if (cameraBtn) {
    cameraBtn.addEventListener("click", function () {
      if (!this.disabled) {
        cameraInput.click();
      }
    });
  }

  // 🖼 画像選択ボタン
  if (selectImageBtn) {
    selectImageBtn.addEventListener("click", function () {
      fileInput.click();
    });
  }

  if (analyzeBtn) {
    analyzeBtn.addEventListener("click", uploadImage);
  }

  if (recheckBtn) {
    recheckBtn.addEventListener("click", recheckDrugs);
  }

});
