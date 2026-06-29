import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import {
  doc,
  getDoc,
  getFirestore,
  onSnapshot,
  setDoc
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

(function () {
  "use strict";

  const DB_NAME = "paper-revisit-db";
  const DB_VERSION = 1;
  const SETTINGS_KEY = "paper-revisit-settings";
  const PIN_KEY = "paper-revisit-pin-ok";
  const APP_PIN = "2684";
  const DAY = 24 * 60 * 60 * 1000;
  const REVIEW_STEPS = [
    { label: "next day", min: 1, max: 1 },
    { label: "3-4 days", min: 3, max: 4 },
    { label: "7-10 days", min: 7, max: 10 },
    { label: "3-4 weeks", min: 21, max: 28 },
    { label: "2-3 months", min: 60, max: 90 },
    { label: "6-12 months", min: 180, max: 365 }
  ];

  const state = {
    db: null,
    papers: [],
    selectedPaperId: null,
    selectedSegmentId: null,
    selectedReviewId: null,
    selectedRating: "normal",
    stagedPdf: null,
    adminMode: false,
    firebaseReady: false,
    firestore: null,
    unsubscribeRemote: null,
    remoteLoaded: false,
    savingRemote: false,
    syncStatus: "Local only",
    settings: {
      avoidWeekends: true
    },
    localPdfs: new Map(),
    objectUrls: new Map()
  };

  const els = {};

  document.addEventListener("DOMContentLoaded", init);

  async function init() {
    cacheElements();
    bindPinGate();
    if (!isPinUnlocked()) {
      showPinGate();
      return;
    }
    unlockApp();
    await startApp();
  }

  async function startApp() {
    bindEvents();
    state.db = await openDb();
    loadSettings();
    await loadLocalPdfs();
    setupFirebase();
    render();
  }

  function cacheElements() {
    [
      "newPaperButton", "paperModal", "paperForm", "pdfInput", "dropZone", "dropTitle",
      "dropMeta", "paperTitleInput", "paperAuthorsInput", "startPageInput", "endPageInput",
      "dueFocus", "focusTitle", "focusMeta", "focusActions", "dueList",
      "readingList", "toReadList", "scheduleList", "libraryList", "dueCount",
      "readingCount", "toReadCount", "readModal", "readForm", "readModalTitle",
      "readModalMeta", "readPdfFrame", "readNotesInput",
      "finishFullButton", "finishPartialButton", "partialPageInput", "reviewModal",
      "reviewForm", "reviewModalTitle", "reviewModalMeta", "reviewPdfFrame",
      "reviewNotesInput", "openReviewPdfButton", "completeReviewButton",
      "completeReviewOnDateButton", "reviewDateInput", "emptyTemplate",
      "avoidWeekendsToggle", "syncStatus", "pinGate", "pinForm", "pinInput",
      "pinError", "appShell"
    ].forEach((id) => {
      els[id] = document.getElementById(id);
    });
  }

  function bindPinGate() {
    els.pinForm.addEventListener("submit", (event) => {
      event.preventDefault();
      if (els.pinInput.value === APP_PIN) {
        localStorage.setItem(PIN_KEY, "true");
        els.pinError.textContent = "";
        unlockApp();
        startApp();
        return;
      }
      els.pinInput.value = "";
      els.pinError.textContent = "Incorrect PIN.";
      els.pinInput.focus();
    });
  }

  function isPinUnlocked() {
    return localStorage.getItem(PIN_KEY) === "true";
  }

  function showPinGate() {
    els.pinGate.classList.remove("hidden");
    els.appShell.classList.add("locked");
    els.pinInput.focus();
  }

  function unlockApp() {
    els.pinGate.classList.add("hidden");
    els.appShell.classList.remove("locked");
  }

  function bindEvents() {
    els.newPaperButton.addEventListener("click", () => openPaperModal());
    els.paperForm.addEventListener("submit", handlePaperSubmit);
    els.pdfInput.addEventListener("change", (event) => handlePdfFile(event.target.files[0]));
    els.dropZone.addEventListener("dragover", (event) => {
      event.preventDefault();
      els.dropZone.classList.add("dragover");
    });
    els.dropZone.addEventListener("dragleave", () => els.dropZone.classList.remove("dragover"));
    els.dropZone.addEventListener("drop", (event) => {
      event.preventDefault();
      els.dropZone.classList.remove("dragover");
      handlePdfFile(event.dataTransfer.files[0]);
    });
    els.finishFullButton.addEventListener("click", () => finishInitialRead(false));
    els.finishPartialButton.addEventListener("click", () => finishInitialRead(true));
    els.openReviewPdfButton.addEventListener("click", openReviewPdf);
    els.completeReviewButton.addEventListener("click", () => completeReview(todayString()));
    els.completeReviewOnDateButton.addEventListener("click", () => completeReview(els.reviewDateInput.value));
    els.avoidWeekendsToggle.addEventListener("change", () => {
      state.settings.avoidWeekends = els.avoidWeekendsToggle.checked;
      saveSettings();
      saveRemoteState();
      render();
    });
    document.querySelectorAll(".rating-button").forEach((button) => {
      button.addEventListener("click", () => selectRating(button.dataset.rating));
    });
  }

  function openDb() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        db.createObjectStore("papers", { keyPath: "id" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  function getStore(mode) {
    return state.db.transaction("papers", mode).objectStore("papers");
  }

  function getAllLocalRecords() {
    return new Promise((resolve, reject) => {
      const request = getStore("readonly").getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  function putLocalRecord(record) {
    return new Promise((resolve, reject) => {
      const request = getStore("readwrite").put(record);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  function deleteLocalRecord(paperId) {
    return new Promise((resolve, reject) => {
      const request = getStore("readwrite").delete(paperId);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  async function loadLocalPdfs() {
    const records = await getAllLocalRecords();
    state.localPdfs.clear();
    records.forEach((record) => {
      if (record.pdfBlob) {
        state.localPdfs.set(record.id, record.pdfBlob);
      }
    });
    if (!state.firebaseReady) {
      state.papers = records
        .filter((record) => record.title)
        .map((record) => ({ ...record, hasLocalPdf: Boolean(record.pdfBlob) }))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    }
  }

  function loadSettings() {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
    state.settings = {
      avoidWeekends: saved.avoidWeekends !== false
    };
  }

  function saveSettings() {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
  }

  function setupFirebase() {
    if (!isFirebaseConfigured()) {
      state.syncStatus = "Local only - Firebase not configured";
      return;
    }
    const app = initializeApp(firebaseConfig);
    state.firestore = getFirestore(app);
    state.firebaseReady = true;
    state.syncStatus = "Syncing";
    loadRemoteState()
      .then(() => {
        subscribeRemoteState();
        state.syncStatus = "Synced";
        render();
      })
      .catch((error) => {
        console.error(error);
        state.syncStatus = "Sync unavailable";
        render();
      });
  }

  function isFirebaseConfigured() {
    return firebaseConfig
      && firebaseConfig.apiKey
      && !firebaseConfig.apiKey.startsWith("YOUR_")
      && firebaseConfig.projectId
      && !firebaseConfig.projectId.startsWith("YOUR_");
  }

  function remoteDocRef() {
    return doc(state.firestore, "app", "state");
  }

  async function loadRemoteState() {
    const snapshot = await getDoc(remoteDocRef());
    if (snapshot.exists()) {
      applyRemoteState(snapshot.data());
      return;
    }
    await saveRemoteState();
  }

  function subscribeRemoteState() {
    state.unsubscribeRemote = onSnapshot(remoteDocRef(), (snapshot) => {
      if (state.savingRemote) return;
      if (!snapshot.exists()) return;
      applyRemoteState(snapshot.data());
      render();
    });
  }

  function applyRemoteState(data) {
    state.remoteLoaded = true;
    state.settings = {
      avoidWeekends: !data.settings || data.settings.avoidWeekends !== false
    };
    saveSettings();
    state.papers = (data.papers || [])
      .map((paper) => ({
        ...paper,
        hasLocalPdf: state.localPdfs.has(paper.id)
      }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async function saveRemoteState() {
    if (!state.firestore) return;
    state.savingRemote = true;
    try {
      await setDoc(remoteDocRef(), {
        settings: state.settings,
        papers: state.papers.map(stripLocalFields),
        updatedAt: new Date().toISOString()
      });
    } finally {
      state.savingRemote = false;
    }
  }

  function stripLocalFields(paper) {
    const { pdfBlob, hasLocalPdf, ...metadata } = paper;
    return metadata;
  }

  async function savePaper(paper) {
    paper.updatedAt = new Date().toISOString();
    if (state.firebaseReady) {
      await saveRemoteState();
    } else {
      await putLocalRecord({ ...paper, pdfBlob: state.localPdfs.get(paper.id) || paper.pdfBlob });
    }
    render();
  }

  function openPaperModal() {
    state.stagedPdf = null;
    els.paperForm.reset();
    els.startPageInput.value = "1";
    els.dropTitle.textContent = "Drop a PDF here or choose a file";
    els.dropMeta.textContent = "The app will try to guess the title. You can edit it before adding.";
    els.paperModal.showModal();
  }

  async function handlePdfFile(file) {
    if (!file || file.type !== "application/pdf") return;
    state.stagedPdf = file;
    els.dropTitle.textContent = file.name;
    els.dropMeta.textContent = `${formatBytes(file.size)} PDF selected`;
    if (!els.paperTitleInput.value.trim()) {
      const title = await guessPdfTitle(file);
      els.paperTitleInput.value = title || cleanTitleFromFilename(file.name);
    }
  }

  async function guessPdfTitle(file) {
    const sample = await file.slice(0, Math.min(file.size, 2_000_000)).arrayBuffer();
    const text = new TextDecoder("latin1").decode(sample);
    const titleMatch = text.match(/\/Title\s*\(([^)]{3,240})\)/i);
    if (titleMatch) return decodePdfString(titleMatch[1]);
    const xmlMatch = text.match(/<dc:title>[\s\S]*?<rdf:li[^>]*>([\s\S]{3,240}?)<\/rdf:li>/i);
    if (xmlMatch) return stripXml(xmlMatch[1]);
    const altMatch = text.match(/<title>([\s\S]{3,180}?)<\/title>/i);
    if (altMatch) return stripXml(altMatch[1]);
    return "";
  }

  function decodePdfString(value) {
    return value.replace(/\\([nrtbf()\\])/g, (_, char) => {
      const map = { n: " ", r: " ", t: " ", b: "", f: "", "(": "(", ")": ")", "\\": "\\" };
      return map[char] || char;
    }).replace(/\s+/g, " ").trim();
  }

  function stripXml(value) {
    const doc = new DOMParser().parseFromString(value, "text/html");
    return doc.body.textContent.replace(/\s+/g, " ").trim();
  }

  function cleanTitleFromFilename(name) {
    return name.replace(/\.pdf$/i, "").replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  }

  async function handlePaperSubmit(event) {
    if (event.submitter && event.submitter.value === "cancel") return;
    event.preventDefault();
    if (isAdminModeRequest()) {
      enterAdminMode();
      els.paperModal.close();
      return;
    }
    if (!state.stagedPdf) {
      els.dropMeta.textContent = "Choose a PDF before adding the paper.";
      return;
    }
    const startPage = Math.max(1, Number(els.startPageInput.value) || 1);
    const endPageRaw = els.endPageInput.value.trim();
    const paper = {
      id: uid(),
      title: els.paperTitleInput.value.trim(),
      authors: els.paperAuthorsInput.value.trim(),
      fileName: state.stagedPdf.name,
      hasLocalPdf: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      segments: [],
      reviews: []
    };
    paper.segments.push({
      id: uid(),
      startPage,
      endPage: endPageRaw || "end",
      status: "reading",
      notes: "",
      initialReadAt: null,
      createdAt: new Date().toISOString()
    });
    state.localPdfs.set(paper.id, state.stagedPdf);
    await putLocalRecord({ id: paper.id, pdfBlob: state.stagedPdf });
    state.papers = [paper, ...state.papers].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    await saveRemoteState();
    if (!state.firebaseReady) {
      await putLocalRecord({ ...paper, pdfBlob: state.stagedPdf });
    }
    els.paperModal.close();
    render();
  }

  function render() {
    const due = dueReviews();
    const reading = segmentsByStatus("reading");
    const toRead = segmentsByStatus("to-read");
    renderFocus(due);
    renderList(els.dueList, due, renderDueItem);
    renderList(els.readingList, reading, renderReadingItem);
    renderList(els.toReadList, toRead, renderToReadItem);
    renderSchedule();
    renderLibrary();
    els.dueCount.textContent = due.length;
    els.readingCount.textContent = reading.length;
    els.toReadCount.textContent = toRead.length;
    document.body.classList.toggle("admin-mode", state.adminMode);
    els.avoidWeekendsToggle.checked = state.settings.avoidWeekends;
    els.syncStatus.textContent = state.syncStatus;
  }

  function renderFocus(due) {
    els.focusActions.innerHTML = "";
    if (!due.length) {
      const next = allOpenReviews().sort((a, b) => a.review.dueDate.localeCompare(b.review.dueDate))[0];
      els.focusTitle.textContent = "Nothing due today";
      els.focusMeta.textContent = next
        ? `Next scheduled: ${segmentLabel(next.paper, next.segment)} on ${formatDate(next.review.dueDate)}.`
        : "Add a paper or continue reading from the shelves below.";
      return;
    }
    const item = due[0];
    els.focusTitle.textContent = segmentLabel(item.paper, item.segment);
    els.focusMeta.textContent = `${reviewStepLabel(item.review.step)} revisit due ${relativeDate(item.review.dueDate)}. Start by reconstructing the ideas before opening the PDF.`;
    const button = buttonEl("Start review", "button primary", () => openReview(item.paper.id, item.segment.id, item.review.id));
    els.focusActions.append(button);
  }

  function renderList(container, items, renderer) {
    container.innerHTML = "";
    if (!items.length) {
      container.append(emptyState());
      return;
    }
    items.forEach((item) => container.append(renderer(item)));
  }

  function renderDueItem(item) {
    const node = itemShell(item.review.dueDate < todayString() ? "late" : "due", relativeDate(item.review.dueDate));
    fillItem(node, segmentLabel(item.paper, item.segment), `${reviewStepLabel(item.review.step)} revisit · ${item.paper.authors || "No authors listed"}`, item.segment.notes);
    node.querySelector(".item-actions").append(
      buttonEl("Review", "mini-button primary", () => openReview(item.paper.id, item.segment.id, item.review.id)),
      buttonEl("PDF", "mini-button", () => openPdfTab(item.paper))
    );
    if (state.adminMode) {
      node.querySelector(".item-actions").append(
        buttonEl("Delete review", "mini-button danger", () => deleteReview(item.paper.id, item.review.id))
      );
    }
    return node;
  }

  function renderReadingItem(item) {
    const node = itemShell("reading", "reading");
    fillItem(node, segmentLabel(item.paper, item.segment), item.paper.authors || "Initial read in progress", item.segment.notes);
    node.querySelector(".item-actions").append(
      buttonEl("Continue", "mini-button primary", () => openRead(item.paper.id, item.segment.id)),
      buttonEl("PDF", "mini-button", () => openPdfTab(item.paper))
    );
    return node;
  }

  function renderToReadItem(item) {
    const node = itemShell("", "to read");
    fillItem(node, segmentLabel(item.paper, item.segment), item.paper.authors || "Unread remainder", item.segment.notes);
    node.querySelector(".item-actions").append(
      buttonEl("Start reading", "mini-button primary", () => startReading(item.paper.id, item.segment.id)),
      buttonEl("PDF", "mini-button", () => openPdfTab(item.paper))
    );
    return node;
  }

  function itemShell(pillClass, pillText) {
    const node = document.createElement("article");
    node.className = "item";
    node.innerHTML = `
      <div class="item-header">
        <div>
          <div class="item-title"></div>
          <div class="item-meta"></div>
        </div>
        <span class="pill ${pillClass}">${escapeHtml(pillText)}</span>
      </div>
      <div class="item-body"></div>
      <div class="item-actions"></div>
    `;
    return node;
  }

  function fillItem(node, title, meta, body) {
    node.querySelector(".item-title").textContent = title;
    node.querySelector(".item-meta").textContent = meta;
    node.querySelector(".item-body").textContent = body || "";
  }

  function renderSchedule() {
    const reviews = allOpenReviews().sort((a, b) => a.review.dueDate.localeCompare(b.review.dueDate));
    els.scheduleList.innerHTML = "";
    if (!reviews.length) {
      els.scheduleList.append(emptyState());
      return;
    }
    const groups = groupBy(reviews, (item) => item.review.dueDate);
    Object.entries(groups).slice(0, 14).forEach(([date, items]) => {
      const row = document.createElement("div");
      row.className = "timeline-day";
      const load = items.reduce((sum, item) => sum + reviewWeight(item.segment, item.review), 0);
      row.innerHTML = `
        <div class="date-chip">${formatShortDate(date)}<small>load ${load}</small></div>
        <div class="list"></div>
      `;
      const list = row.querySelector(".list");
      items.forEach((item) => {
        const node = itemShell(item.review.dueDate <= todayString() ? "due" : "", reviewStepLabel(item.review.step));
        fillItem(node, segmentLabel(item.paper, item.segment), relativeDate(item.review.dueDate), "");
        if (state.adminMode) {
          node.querySelector(".item-actions").append(
            buttonEl("Delete review", "mini-button danger", () => deleteReview(item.paper.id, item.review.id))
          );
        }
        list.append(node);
      });
      els.scheduleList.append(row);
    });
  }

  function renderLibrary() {
    els.libraryList.innerHTML = "";
    if (!state.papers.length) {
      els.libraryList.append(emptyState());
      return;
    }
    state.papers.forEach((paper) => {
      const node = itemShell("", `${paper.reviews.filter((review) => review.completedAt).length} reviews`);
      const segments = paper.segments.map((segment) => `${pageRange(segment)}: ${segment.status}`).join(" · ");
      fillItem(node, paper.title, paper.authors || "No authors listed", segments);
      const history = document.createElement("div");
      history.className = "history";
      history.textContent = reviewHistoryText(paper);
      node.append(history);
      node.querySelector(".item-actions").append(
        buttonEl("PDF", "mini-button", () => openPdfTab(paper))
      );
      if (state.adminMode) {
        node.querySelector(".item-actions").append(
          buttonEl("Delete paper", "mini-button danger", () => deletePaper(paper.id))
        );
      }
      els.libraryList.append(node);
    });
  }

  function isAdminModeRequest() {
    return els.paperTitleInput.value.trim().toLowerCase() === "admin"
      && !state.stagedPdf
      && !els.paperAuthorsInput.value.trim()
      && (Number(els.startPageInput.value) || 1) === 1
      && !els.endPageInput.value.trim();
  }

  function enterAdminMode() {
    state.adminMode = true;
    render();
  }

  async function deleteReview(paperId, reviewId) {
    const paper = findPaper(paperId);
    const review = paper.reviews.find((candidate) => candidate.id === reviewId);
    if (!review) return;
    const confirmed = window.confirm(`Delete this scheduled review for "${paper.title}"?`);
    if (!confirmed) return;
    paper.reviews = paper.reviews.filter((candidate) => candidate.id !== reviewId);
    await savePaper(paper);
  }

  async function deletePaper(paperId) {
    const paper = findPaper(paperId);
    const confirmed = window.confirm(`Delete "${paper.title}" from the paper library? This removes its segments and review history too.`);
    if (!confirmed) return;
    const url = state.objectUrls.get(paperId);
    if (url) {
      URL.revokeObjectURL(url);
      state.objectUrls.delete(paperId);
    }
    state.localPdfs.delete(paperId);
    await deleteLocalRecord(paperId);
    state.papers = state.papers.filter((candidate) => candidate.id !== paperId);
    await saveRemoteState();
    render();
  }

  function reviewHistoryText(paper) {
    const complete = paper.reviews.filter((review) => review.completedAt);
    if (!complete.length) return "No completed reviews yet.";
    return complete
      .slice(-4)
      .reverse()
      .map((review) => {
        const date = review.actualReviewDate || review.completedAt.slice(0, 10);
        return `${formatDate(date)}: ${reviewStepLabel(review.step)} · ${review.rating}`;
      })
      .join(" | ");
  }

  function emptyState() {
    return els.emptyTemplate.content.firstElementChild.cloneNode(true);
  }

  async function startReading(paperId, segmentId) {
    const paper = findPaper(paperId);
    const segment = paper.segments.find((candidate) => candidate.id === segmentId);
    segment.status = "reading";
    await savePaper(paper);
    openRead(paperId, segmentId);
  }

  function openRead(paperId, segmentId) {
    const paper = findPaper(paperId);
    const segment = paper.segments.find((candidate) => candidate.id === segmentId);
    state.selectedPaperId = paperId;
    state.selectedSegmentId = segmentId;
    els.readModalTitle.textContent = segmentLabel(paper, segment);
    els.readModalMeta.textContent = paper.authors || "";
    els.readNotesInput.value = segment.notes || "";
    els.partialPageInput.value = "";
    setFramePdf(els.readPdfFrame, paper);
    els.readModal.showModal();
  }

  async function finishInitialRead(isPartial) {
    const paper = findPaper(state.selectedPaperId);
    const segment = paper.segments.find((candidate) => candidate.id === state.selectedSegmentId);
    const readDate = todayString();
    segment.notes = els.readNotesInput.value.trim();
    segment.initialReadAt = readDate;
    segment.status = "scheduled";

    if (isPartial) {
      const stoppedAt = Number(els.partialPageInput.value);
      if (!stoppedAt || stoppedAt < Number(segment.startPage)) {
        els.partialPageInput.focus();
        return;
      }
      const originalEnd = segment.endPage || "end";
      segment.endPage = stoppedAt;
      const nextStart = stoppedAt + 1;
      if (originalEnd === "end" || Number(originalEnd) >= nextStart) {
        paper.segments.push({
          id: uid(),
          startPage: nextStart,
          endPage: originalEnd,
          status: "to-read",
          notes: "",
          initialReadAt: null,
          createdAt: new Date().toISOString()
        });
      }
    }

    paper.reviews.push(createReview(paper, segment, 0, "normal", readDate));
    els.readModal.close();
    await savePaper(paper);
  }

  function openReview(paperId, segmentId, reviewId) {
    const paper = findPaper(paperId);
    const segment = paper.segments.find((candidate) => candidate.id === segmentId);
    const review = paper.reviews.find((candidate) => candidate.id === reviewId);
    state.selectedPaperId = paperId;
    state.selectedSegmentId = segmentId;
    state.selectedReviewId = reviewId;
    state.selectedRating = "normal";
    selectRating("normal");
    els.reviewModalTitle.textContent = segmentLabel(paper, segment);
    els.reviewModalMeta.textContent = `${reviewStepLabel(review.step)} revisit · due ${formatDate(review.dueDate)}`;
    els.reviewNotesInput.value = "";
    els.reviewDateInput.value = todayString();
    els.reviewDateInput.max = todayString();
    els.reviewDateInput.min = segment.initialReadAt || "";
    els.reviewPdfFrame.classList.add("hidden");
    els.reviewPdfFrame.removeAttribute("src");
    els.reviewModal.showModal();
  }

  function openReviewPdf() {
    const paper = findPaper(state.selectedPaperId);
    setFramePdf(els.reviewPdfFrame, paper);
    els.reviewPdfFrame.classList.remove("hidden");
  }

  function selectRating(rating) {
    state.selectedRating = rating;
    document.querySelectorAll(".rating-button").forEach((button) => {
      button.classList.toggle("selected", button.dataset.rating === rating);
    });
  }

  async function completeReview(actualReviewDate) {
    const paper = findPaper(state.selectedPaperId);
    const segment = paper.segments.find((candidate) => candidate.id === state.selectedSegmentId);
    if (!isValidReviewDate(actualReviewDate, segment.initialReadAt)) {
      els.reviewDateInput.focus();
      return;
    }
    const review = paper.reviews.find((candidate) => candidate.id === state.selectedReviewId);
    review.completedAt = new Date().toISOString();
    review.actualReviewDate = actualReviewDate;
    review.rating = state.selectedRating;
    review.notes = els.reviewNotesInput.value.trim();

    const nextStep = state.selectedRating === "soon" ? review.step : review.step + 1;
    if (nextStep < REVIEW_STEPS.length) {
      paper.reviews.push(createReview(paper, segment, nextStep, state.selectedRating, actualReviewDate));
    } else {
      segment.status = "complete";
    }
    els.reviewModal.close();
    await savePaper(paper);
  }

  function isValidReviewDate(value, minDate) {
    if (!value) return false;
    const date = parseLocalDate(value);
    return !Number.isNaN(date.getTime()) && value <= todayString() && (!minDate || value >= minDate);
  }

  function createReview(paper, segment, step, rating, anchorDate) {
    return {
      id: uid(),
      segmentId: segment.id,
      step,
      dueDate: chooseDueDate(paper, segment, step, rating, anchorDate),
      rating,
      notes: "",
      createdAt: new Date().toISOString(),
      completedAt: null
    };
  }

  function chooseDueDate(paper, segment, step, rating, anchorDate) {
    const interval = REVIEW_STEPS[step];
    const base = parseLocalDate(anchorDate || segment.initialReadAt || todayString());
    let minOffset = interval.min;
    let maxOffset = interval.max;
    if (rating === "soon") maxOffset = interval.min;
    if (rating === "later") minOffset = interval.max;

    const start = addDays(base, minOffset);
    const end = addDays(base, maxOffset);
    const candidates = schedulingCandidates(start, end);
    const loads = buildDateLoads(paper.id);
    const weight = reviewWeight(segment, { rating });
    candidates.sort((a, b) => {
      const loadA = (loads[toDateString(a)] || 0) + weight;
      const loadB = (loads[toDateString(b)] || 0) + weight;
      if (loadA !== loadB) return loadA - loadB;
      return a - b;
    });
    return toDateString(candidates[0]);
  }

  function schedulingCandidates(start, end) {
    const candidates = datesBetween(start, end);
    if (!state.settings.avoidWeekends) return candidates;
    const weekdays = candidates.filter((date) => !isWeekend(date));
    if (weekdays.length) return weekdays;
    const fallback = nextWeekdayAfter(end);
    return [fallback];
  }

  function isWeekend(date) {
    return date.getDay() === 0 || date.getDay() === 6;
  }

  function nextWeekdayAfter(date) {
    let next = addDays(date, 1);
    while (isWeekend(next)) {
      next = addDays(next, 1);
    }
    return next;
  }

  function buildDateLoads(ignorePaperId) {
    const loads = {};
    allOpenReviews()
      .filter((item) => item.paper.id !== ignorePaperId)
      .forEach((item) => {
        loads[item.review.dueDate] = (loads[item.review.dueDate] || 0) + reviewWeight(item.segment, item.review);
      });
    return loads;
  }

  function reviewWeight(segment, review) {
    let weight = 1;
    const start = Number(segment.startPage);
    const end = Number(segment.endPage);
    if (end && start && end - start >= 20) weight += 1;
    if (review.rating === "soon") weight += 1;
    return weight;
  }

  function allOpenReviews() {
    return state.papers.flatMap((paper) => paper.reviews
      .filter((review) => !review.completedAt)
      .map((review) => {
        const segment = paper.segments.find((candidate) => candidate.id === review.segmentId);
        return { paper, segment, review };
      })
      .filter((item) => item.segment));
  }

  function dueReviews() {
    return allOpenReviews()
      .filter((item) => item.review.dueDate <= todayString())
      .sort((a, b) => a.review.dueDate.localeCompare(b.review.dueDate));
  }

  function segmentsByStatus(status) {
    return state.papers.flatMap((paper) => paper.segments
      .filter((segment) => segment.status === status)
      .map((segment) => ({ paper, segment })));
  }

  function findPaper(id) {
    return state.papers.find((paper) => paper.id === id);
  }

  function segmentLabel(paper, segment) {
    return `${paper.title} ${pageRange(segment)}`;
  }

  function pageRange(segment) {
    return `p${segment.startPage}-${segment.endPage || "end"}`;
  }

  function reviewStepLabel(step) {
    return REVIEW_STEPS[step] ? REVIEW_STEPS[step].label : "completed";
  }

  function setFramePdf(frame, paper) {
    const url = getObjectUrl(paper);
    if (!url) {
      frame.removeAttribute("src");
      return;
    }
    frame.src = `${url}#page=1`;
  }

  function openPdfTab(paper) {
    const url = getObjectUrl(paper);
    if (!url) {
      window.alert("This PDF is only stored locally. Upload it on this device to view it here.");
      return;
    }
    window.open(url, "_blank", "noopener");
  }

  function getObjectUrl(paper) {
    const blob = state.localPdfs.get(paper.id) || paper.pdfBlob;
    if (!blob) return "";
    if (!state.objectUrls.has(paper.id)) {
      state.objectUrls.set(paper.id, URL.createObjectURL(blob));
    }
    return state.objectUrls.get(paper.id);
  }

  function buttonEl(text, className, onClick) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = className;
    button.textContent = text;
    button.addEventListener("click", onClick);
    return button;
  }

  function groupBy(items, keyFn) {
    return items.reduce((groups, item) => {
      const key = keyFn(item);
      groups[key] = groups[key] || [];
      groups[key].push(item);
      return groups;
    }, {});
  }

  function uid() {
    return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function todayString() {
    return toDateString(startOfToday());
  }

  function startOfToday() {
    const date = new Date();
    date.setHours(0, 0, 0, 0);
    return date;
  }

  function parseLocalDate(value) {
    const [year, month, day] = value.split("-").map(Number);
    return new Date(year, month - 1, day);
  }

  function addDays(date, days) {
    const next = new Date(date);
    next.setDate(next.getDate() + days);
    return next;
  }

  function datesBetween(start, end) {
    const dates = [];
    for (let date = new Date(start); date <= end; date = addDays(date, 1)) {
      dates.push(new Date(date));
    }
    return dates;
  }

  function toDateString(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function formatDate(value) {
    return parseLocalDate(value).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric"
    });
  }

  function formatShortDate(value) {
    return parseLocalDate(value).toLocaleDateString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric"
    });
  }

  function relativeDate(value) {
    const diff = Math.round((parseLocalDate(value) - startOfToday()) / DAY);
    if (diff === 0) return "today";
    if (diff === 1) return "tomorrow";
    if (diff === -1) return "yesterday";
    if (diff < 0) return `${Math.abs(diff)} days late`;
    return `in ${diff} days`;
  }

  function formatBytes(bytes) {
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
})();
