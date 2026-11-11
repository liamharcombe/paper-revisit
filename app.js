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
  const APP_PIN_HASH = "85c7fe9319004e487cdde0f895d742b3be1b0b474708fd7162e404f32f373629";
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
    editingPaperId: null,
    editingSegmentId: null,
    editingReviewId: null,
    adminMode: false,
    firebaseReady: false,
    firestore: null,
    unsubscribeRemote: null,
    remoteLoaded: false,
    savingRemote: false,
    syncStatus: "Local only",
    settings: {
      avoidWeekends: true,
      emailReminders: true
    }
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
    await loadLocalPapers();
    setupFirebase();
    render();
  }

  function cacheElements() {
    [
      "newPaperButton", "paperModal", "paperForm",
      "paperTitleInput", "paperAuthorsInput", "startPageInput", "endPageInput",
      "dueList", "scheduleList", "dueCount", "editModal", "editForm", "editModalTitle",
      "editTitleInput", "editAuthorsInput", "editStartPageInput", "editEndPageInput",
      "editDueDateInput", "editNotesInput", "deleteItemButton", "reviewModal",
      "reviewModalTitle", "completeReviewButton",
      "completeReviewOnDateButton", "reviewDateInput", "emptyTemplate",
      "avoidWeekendsToggle", "emailRemindersToggle", "syncStatus", "pinGate",
      "pinForm", "pinInput", "pinError", "appShell"
    ].forEach((id) => {
      els[id] = document.getElementById(id);
    });
  }

  function bindPinGate() {
    els.pinForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (await sha256Hex(els.pinInput.value) === APP_PIN_HASH) {
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

  async function sha256Hex(value) {
    const bytes = new TextEncoder().encode(value);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
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
    els.editForm.addEventListener("submit", handleEditSubmit);
    els.deleteItemButton.addEventListener("click", deleteEditedItem);
    document.querySelectorAll(".modal-close").forEach((button) => {
      button.addEventListener("click", () => button.closest("dialog").close());
    });
    els.completeReviewButton.addEventListener("click", () => completeReview(todayString()));
    els.completeReviewOnDateButton.addEventListener("click", () => completeReview(els.reviewDateInput.value));
    els.avoidWeekendsToggle.addEventListener("change", () => {
      state.settings.avoidWeekends = els.avoidWeekendsToggle.checked;
      saveSettings();
      saveRemoteState();
      render();
    });
    els.emailRemindersToggle.addEventListener("change", () => {
      state.settings.emailReminders = els.emailRemindersToggle.checked;
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

  async function loadLocalPapers() {
    const records = await getAllLocalRecords();
    if (!state.firebaseReady) {
      state.papers = records
        .filter((record) => record.title)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      if (scheduleLegacySegments()) {
        await Promise.all(state.papers.map(putLocalRecord));
      }
    }
  }

  function loadSettings() {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
    state.settings = {
      avoidWeekends: saved.avoidWeekends !== false,
      emailReminders: saved.emailReminders !== false
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
      avoidWeekends: !data.settings || data.settings.avoidWeekends !== false,
      emailReminders: !data.settings || data.settings.emailReminders !== false
    };
    saveSettings();
    state.papers = (data.papers || [])
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    if (scheduleLegacySegments()) {
      saveRemoteState();
    }
  }

  function scheduleLegacySegments() {
    let changed = false;
    state.papers.forEach((paper) => {
      paper.segments.forEach((segment) => {
        const hasOpenReview = paper.reviews.some((review) => (
          review.segmentId === segment.id && !review.completedAt
        ));
        if ((segment.status === "reading" || segment.status === "to-read") && !hasOpenReview) {
          segment.status = "scheduled";
          segment.initialReadAt = segment.initialReadAt || todayString();
          paper.reviews.push(createReview(paper, segment, 0, "normal", segment.initialReadAt));
          changed = true;
        }
      });
    });
    return changed;
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
    const { pdfBlob, hasLocalPdf, fileName, ...metadata } = paper;
    return metadata;
  }

  async function savePaper(paper) {
    paper.updatedAt = new Date().toISOString();
    if (state.firebaseReady) {
      await saveRemoteState();
    } else {
      await putLocalRecord(paper);
    }
    render();
  }

  function openPaperModal() {
    els.paperForm.reset();
    els.startPageInput.value = "1";
    els.paperModal.showModal();
  }

  async function handlePaperSubmit(event) {
    if (event.submitter && event.submitter.value === "cancel") return;
    event.preventDefault();
    if (isAdminModeRequest()) {
      enterAdminMode();
      els.paperModal.close();
      return;
    }
    const startPage = Math.max(1, Number(els.startPageInput.value) || 1);
    const endPageRaw = els.endPageInput.value.trim();
    const paper = {
      id: uid(),
      title: els.paperTitleInput.value.trim(),
      authors: els.paperAuthorsInput.value.trim(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      segments: [],
      reviews: []
    };
    const segment = {
      id: uid(),
      startPage,
      endPage: endPageRaw || "end",
      status: "scheduled",
      notes: "",
      initialReadAt: todayString(),
      createdAt: new Date().toISOString()
    };
    paper.segments.push(segment);
    paper.reviews.push(createReview(paper, segment, 0, "normal", segment.initialReadAt));
    state.papers = [paper, ...state.papers].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    await saveRemoteState();
    if (!state.firebaseReady) {
      await putLocalRecord(paper);
    }
    els.paperModal.close();
    render();
  }

  function render() {
    const due = dueReviews();
    renderList(els.dueList, due, renderDueItem);
    renderSchedule();
    els.dueCount.textContent = due.length;
    document.body.classList.toggle("admin-mode", state.adminMode);
    els.avoidWeekendsToggle.checked = state.settings.avoidWeekends;
    els.emailRemindersToggle.checked = state.settings.emailReminders;
    els.syncStatus.textContent = state.syncStatus;
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
      buttonEl("Edit", "mini-button", () => openEdit(item.paper.id, item.segment.id, item.review.id))
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
    const reviews = allOpenReviews()
      .filter((item) => item.review.dueDate > todayString())
      .sort((a, b) => a.review.dueDate.localeCompare(b.review.dueDate));
    els.scheduleList.innerHTML = "";
    if (!reviews.length) {
      els.scheduleList.append(emptyState());
      return;
    }
    const groups = groupBy(reviews, (item) => item.review.dueDate);
    Object.entries(groups).forEach(([date, items]) => {
      const row = document.createElement("div");
      row.className = "timeline-day";
      const load = items.reduce((sum, item) => sum + reviewWeight(item.segment, item.review), 0);
      row.innerHTML = `
        <div class="date-chip">${formatShortDate(date)}<small>load ${load}</small></div>
        <div class="list"></div>
      `;
      const list = row.querySelector(".list");
      items.forEach((item) => {
        const node = itemShell("", reviewStepLabel(item.review.step));
        const meta = `${item.paper.authors || "No author"} · ${relativeDate(item.review.dueDate)}`;
        fillItem(node, segmentLabel(item.paper, item.segment), meta, "");
        node.querySelector(".item-actions").append(
          buttonEl("Edit", "mini-button", () => openEdit(item.paper.id, item.segment.id, item.review.id))
        );
        list.append(node);
      });
      els.scheduleList.append(row);
    });
  }

  function isAdminModeRequest() {
    return els.paperTitleInput.value.trim().toLowerCase() === "admin"
      && !els.paperAuthorsInput.value.trim()
      && (Number(els.startPageInput.value) || 1) === 1
      && !els.endPageInput.value.trim();
  }

  function enterAdminMode() {
    state.adminMode = true;
    render();
  }

  function emptyState() {
    return els.emptyTemplate.content.firstElementChild.cloneNode(true);
  }

  function openEdit(paperId, segmentId, reviewId) {
    const paper = findPaper(paperId);
    const segment = paper.segments.find((candidate) => candidate.id === segmentId);
    const review = paper.reviews.find((candidate) => candidate.id === reviewId);
    state.editingPaperId = paperId;
    state.editingSegmentId = segmentId;
    state.editingReviewId = reviewId;
    els.editModalTitle.textContent = segmentLabel(paper, segment);
    els.editTitleInput.value = paper.title;
    els.editAuthorsInput.value = paper.authors || "";
    els.editStartPageInput.value = segment.startPage;
    els.editEndPageInput.value = segment.endPage || "end";
    els.editDueDateInput.value = review.dueDate;
    els.editNotesInput.value = segment.notes || "";
    els.editModal.showModal();
  }

  async function handleEditSubmit(event) {
    event.preventDefault();
    const paper = findPaper(state.editingPaperId);
    const segment = paper.segments.find((candidate) => candidate.id === state.editingSegmentId);
    const review = paper.reviews.find((candidate) => candidate.id === state.editingReviewId);
    paper.title = els.editTitleInput.value.trim();
    paper.authors = els.editAuthorsInput.value.trim();
    segment.startPage = Math.max(1, Number(els.editStartPageInput.value) || 1);
    segment.endPage = els.editEndPageInput.value.trim() || "end";
    segment.notes = els.editNotesInput.value.trim();
    review.dueDate = els.editDueDateInput.value;
    els.editModal.close();
    await savePaper(paper);
  }

  async function deleteEditedItem() {
    const paper = findPaper(state.editingPaperId);
    const segment = paper.segments.find((candidate) => candidate.id === state.editingSegmentId);
    const label = segmentLabel(paper, segment);
    if (!window.confirm(`Delete "${label}" and its review history?`)) return;

    paper.segments = paper.segments.filter((candidate) => candidate.id !== segment.id);
    paper.reviews = paper.reviews.filter((review) => review.segmentId !== segment.id);
    els.editModal.close();

    if (!paper.segments.length) {
      state.papers = state.papers.filter((candidate) => candidate.id !== paper.id);
      await deleteLocalRecord(paper.id);
      await saveRemoteState();
      render();
      return;
    }
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
    els.reviewDateInput.value = todayString();
    els.reviewDateInput.max = todayString();
    els.reviewDateInput.min = segment.initialReadAt || "";
    els.reviewModal.showModal();
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

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
})();
