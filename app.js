// SovereignPrompter Worship Karaoke & Sync System Core Script
// Designed for fasting prayers, live timing synchronisation, and low-light worship displays.

// PRELOADED DEMO DATABASE - Permanently Removed Demo Songs
const defaultSongsList = [];

// Core Global State
let databaseSongs = [];
let activeView = 'dashboard';

// Performance Player view variables
let playingSong = null;
let playerIsPlaying = false;
let playerCurrentTime = 0;
let playerDuration = 120;
let playerPlaybackRate = 1.0;
let playerVolume = 0.8;
let playerVocalAssist = false;
let lastSpokenLyricIndex = -1;
let playerTickerId = null;
let activePrompterIndex = 0;

// Wizard variables
let editingSongId = null;
let wizardRawFile = null;
let wizardAudioUrl = '';
let wizardAudioFileName = '';
let wizardUseSynth = true;
let wizardSyncedLyricsArray = [];
let wizardActiveSyncIndex = 0;
let wizardIsPlaying = false;
let wizardCurrentTime = 0;
let wizardDuration = 120;
let wizardAudioTag = new Audio();
let wizardIntervalId = null;

// Web Audio API Synthesizer Nodes
let synthCtx = null;
let synthOscs = [];
let synthGainNode = null;
let synthFilterNode = null;
let synthIntervalId = null;

// UI Tick updates
setInterval(() => {
  const now = new Date();
  const options = { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true };
  const tracker = document.getElementById('header-time-tracker');
  if (tracker) {
    tracker.textContent = now.toLocaleTimeString('en-US', options);
  }
}, 1000);

// ==================== INTERACTION 1: OFFLINE SYSTEM (IndexedDB) ====================
let offlineDb = null;
const OFFLINE_DB_NAME = "WorshipAppOffline";
const OFFLINE_STORE_NAME = "cached_audio";

function initOfflineIndexedDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(OFFLINE_DB_NAME, 1);
    
    request.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(OFFLINE_STORE_NAME)) {
        db.createObjectStore(OFFLINE_STORE_NAME);
      }
    };
    
    request.onsuccess = (e) => {
      offlineDb = e.target.result;
      resolve(offlineDb);
    };
    
    request.onerror = (e) => {
      console.error("IndexedDB initialization failed:", e.target.error);
      reject(e.target.error);
    };
  });
}

function getAudioFromOfflineCache(songId) {
  return new Promise((resolve) => {
    if (!offlineDb) {
      resolve(null);
      return;
    }
    const transaction = offlineDb.transaction([OFFLINE_STORE_NAME], "readonly");
    const store = transaction.objectStore(OFFLINE_STORE_NAME);
    const request = store.get(songId);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => resolve(null);
  });
}

function saveAudioToOfflineCache(songId, blob) {
  return new Promise((resolve, reject) => {
    if (!offlineDb) {
      reject(new Error("IndexedDB not initialized"));
      return;
    }
    const transaction = offlineDb.transaction([OFFLINE_STORE_NAME], "readwrite");
    const store = transaction.objectStore(OFFLINE_STORE_NAME);
    const request = store.put(blob, songId);
    request.onsuccess = () => resolve(true);
    request.onerror = () => reject(request.error);
  });
}

function deleteAudioFromOfflineCache(songId) {
  return new Promise((resolve, reject) => {
    if (!offlineDb) {
      reject(new Error("IndexedDB not initialized"));
      return;
    }
    const transaction = offlineDb.transaction([OFFLINE_STORE_NAME], "readwrite");
    const store = transaction.objectStore(OFFLINE_STORE_NAME);
    const request = store.delete(songId);
    request.onsuccess = () => resolve(true);
    request.onerror = () => reject(request.error);
  });
}

function checkOfflineSongs() {
  return new Promise((resolve) => {
    if (!offlineDb) {
      resolve([]);
      return;
    }
    const transaction = offlineDb.transaction([OFFLINE_STORE_NAME], "readonly");
    const store = transaction.objectStore(OFFLINE_STORE_NAME);
    const request = store.getAllKeys();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => resolve([]);
  });
}

// ==================== INTERACTION 2: TIMING PARSER HANDLER ====================
function parseLyricLine(textLine, defaultIdx) {
  let time = null;
  let text = textLine.trim();
  
  // Try matching "M:SS: Text" (e.g., 1:15: Lyric Text)
  const m1 = text.match(/^(\d+):(\d+):(.*)$/);
  if (m1) {
    const mins = parseInt(m1[1]);
    const secs = parseInt(m1[2]);
    time = mins * 60 + secs;
    text = m1[3].trim();
  } else {
    // Try matching "SS: Text" (e.g., 75: Lyric Text)
    const m2 = text.match(/^(\d+):(.*)$/);
    if (m2) {
      time = parseInt(m2[1]);
      text = m2[2].trim();
    }
  }

  if (time === null) {
    time = defaultIdx === 0 ? 0.0 : defaultIdx * 6.5;
  }

  return {
    time: parseFloat(time),
    text: text
  };
}

// Initializer
window.onload = function() {
  loadDatabase();
  lucide.createIcons();
};

const OperationType = {
  CREATE: 'create',
  UPDATE: 'update',
  DELETE: 'delete',
  LIST: 'list',
  GET: 'get',
  WRITE: 'write',
};

function handleFirestoreError(error, operationType, path) {
  const errInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: null,
      email: null,
      emailVerified: null,
      isAnonymous: null,
      tenantId: null,
      providerInfo: []
    },
    operationType: operationType,
    path: path
  };
  console.error('Firestore Error Info: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

let unsubFirestore = null;

// Synchronize and initialize Firestore connection and Offline caching in one swipe
async function loadDatabase() {
  await initOfflineIndexedDB();
  
  if (unsubFirestore) {
    unsubFirestore();
  }

  // Fallback loading from local cache on startup
  const localCache = localStorage.getItem('sovereign_prompter_db');
  if (localCache) {
    try {
      databaseSongs = JSON.parse(localCache).filter(s => s.id !== 'grace-demo' && s.id !== 'great-thou-art-demo');
      localStorage.setItem('sovereign_prompter_db', JSON.stringify(databaseSongs));
      updateDashboardStats();
      renderSongsGrid();
    } catch(e) {}
  }

  // Register real-time sync wrapper
  const checkFirebaseReady = setInterval(async () => {
    if (window.db && window.fStore) {
      clearInterval(checkFirebaseReady);
      
      // Explicitly delete demo keys from Cloud Firestore to purge them permanently
      try {
        const graceRef = window.fStore.doc(window.db, "worship_songs", "grace-demo");
        window.fStore.deleteDoc(graceRef).catch(()=>{});
        const greatRef = window.fStore.doc(window.db, "worship_songs", "great-thou-art-demo");
        window.fStore.deleteDoc(greatRef).catch(()=>{});
      } catch (ex) {}
      
      const collRef = window.fStore.collection(window.db, "worship_songs");
      unsubFirestore = window.fStore.onSnapshot(collRef, async (snapshot) => {
        let cloudSongs = [];
        snapshot.forEach(doc => {
          const d = doc.data();
          if (d.id !== 'grace-demo' && d.id !== 'great-thou-art-demo') {
            cloudSongs.push(d);
          }
        });

        // Seed default songs list on first run if database is empty
        if (cloudSongs.length === 0 && defaultSongsList.length > 0) {
          console.log("No songs found in Cloud Firestore. Performing automatic seeding...");
          for (const s of defaultSongsList) {
            const seedPayload = {
              id: s.id,
              title: s.title,
              artist: s.artist || 'Traditional Faith',
              key: s.key || 'G Major',
              tempo: s.tempo || 72,
              audioUrl: s.audioUrl || '',
              audioFileName: s.audioFileName || 'Procedural Piano Synth',
              lyrics: s.lyrics || [],
              lines: s.lyrics || [],
              updatedAt: Date.now()
            };
            try {
              const dRef = window.fStore.doc(window.db, "worship_songs", s.id);
              await window.fStore.setDoc(dRef, seedPayload);
            } catch (err) {
              console.error("Failed to seed default: ", s.id, err);
            }
          }
          return;
        }

        cloudSongs.sort((a,b) => (b.updatedAt || 0) - (a.updatedAt || 0));
        databaseSongs = cloudSongs;
        localStorage.setItem('sovereign_prompter_db', JSON.stringify(databaseSongs));
        
        updateDashboardStats();
        await renderSongsGrid();
        hideDbErrorBanner();
      }, (error) => {
        console.error("Firestore real-time subscription error:", error);
        showDbErrorBanner("Cloud connection error: " + error.message);
        handleFirestoreError(error, OperationType.GET, "worship_songs");
      });
    }
  }, 100);
}

function saveDatabaseToLocalStorage() {
  localStorage.setItem('sovereign_prompter_db', JSON.stringify(databaseSongs));
  updateDashboardStats();
}

function showDbErrorBanner(message) {
  const banner = document.getElementById('db-error-banner');
  const msgEl = document.getElementById('db-error-message');
  if (banner && msgEl) {
    msgEl.textContent = message;
    banner.classList.remove('hidden');
  }
  const dot = document.getElementById('db-status-dot');
  const text = document.getElementById('db-status-text');
  if (dot && text) {
    dot.className = "w-2 h-2 rounded-full bg-red-500";
    text.textContent = "Sync Offline / Local Only";
    text.className = "text-red-400";
  }
}

function hideDbErrorBanner() {
  const banner = document.getElementById('db-error-banner');
  if (banner) {
    banner.classList.add('hidden');
  }
  const dot = document.getElementById('db-status-dot');
  const text = document.getElementById('db-status-text');
  if (dot && text) {
    dot.className = "w-2 h-2 rounded-full bg-emerald-500 animate-pulse";
    text.textContent = "Sync: Real-Time Cloud (Firestore)";
    text.className = "text-emerald-400";
  }
}

function dismissDbErrorBanner() {
  hideDbErrorBanner();
}

function updateDashboardStats() {
  const el = document.getElementById('stats-total-tracks');
  if (el) el.textContent = databaseSongs.length;
}

async function resetAllToDefault() {
  const confirmed = await showConfirm(
    "Restore Default Songs",
    "Are you sure you want to restore the default preloaded worship songs in Cloud Firestore? This will reset all timings.",
    { confirmText: "Restore Defaults", isDanger: true }
  );
  if (confirmed) {
    try {
      // Clear Firestore documents first
      for (const s of databaseSongs) {
        const docRef = window.fStore.doc(window.db, "worship_songs", s.id);
        await window.fStore.deleteDoc(docRef);
        await deleteAudioFromOfflineCache(s.id);
      }
      // Re-trigger loadDatabase to perform auto seeding
      await loadDatabase();
    } catch(e) {
      console.error(e);
      alert("Reset failed: " + e.message);
    }
  }
}

// View switcher helper
function switchView(viewName) {
  activeView = viewName;
  
  const views = ['dashboard', 'wizard', 'player'];
  views.forEach(v => {
    const el = document.getElementById(`view-${v}`);
    if (el) {
      if (v === viewName) {
        el.classList.remove('hidden');
        if (viewName === 'player') el.classList.add('flex');
      } else {
        el.classList.add('hidden');
        if (v === 'player') el.classList.remove('flex');
      }
    }
  });

  // Stop any audio playing
  stopAllWorshipAudio();
}

function stopAllWorshipAudio() {
  // Stop synthesiser
  stopProceduralSynthPad();
  
  // Stop wizard audio
  try {
    wizardAudioTag.pause();
    wizardAudioTag.src = '';
  } catch(e){}
  wizardIsPlaying = false;
  const syncBtn = document.getElementById('wizard-sync-play-btn');
  if (syncBtn) {
    syncBtn.innerHTML = `<i data-lucide="play" class="w-3.5 h-3.5 fill-current"></i> PLAY DEMO TRACK`;
  }
  clearInterval(wizardIntervalId);

  // Stop performance player
  playerIsPlaying = false;
  const nativeAudio = document.getElementById('player-audio-source');
  if (nativeAudio) {
    try { nativeAudio.pause(); } catch(e){}
  }
  if (playerTickerId) {
    cancelAnimationFrame(playerTickerId);
  }
  if (window.speechSynthesis) {
    window.speechSynthesis.cancel();
  }
  
  lucide.createIcons();
}

// ==================== SCREEN 1 LOGIC: DASHBOARD ====================
// ==================== SCREEN 1 LOGIC: DASHBOARD ====================
let openDropdownSongId = null;

function toggleSongDropdown(event, songId) {
  event.stopPropagation();
  const dropdown = document.getElementById(`dropdown-menu-${songId}`);
  if (!dropdown) return;
  
  const isHidden = dropdown.classList.contains('hidden');
  
  closeAllSongDropdowns();
  
  if (isHidden) {
    dropdown.classList.remove('hidden');
    openDropdownSongId = songId;
  }
}

function closeAllSongDropdowns() {
  const dropdowns = document.querySelectorAll('[id^="dropdown-menu-"]');
  dropdowns.forEach(d => d.classList.add('hidden'));
  openDropdownSongId = null;
}

// Close dropdowns upon document clicks
document.addEventListener('click', () => {
  closeAllSongDropdowns();
});

function openSongDetailsEditModal(songId) {
  const song = databaseSongs.find(s => s.id === songId);
  if (!song) return;

  document.getElementById('modal-song-id').textContent = song.id;
  document.getElementById('modal-song-title-input').value = song.title || '';
  document.getElementById('modal-song-artist-input').value = song.artist || '';
  document.getElementById('modal-song-key-select').value = song.key || 'G Major';
  document.getElementById('modal-song-tempo-input').value = song.tempo || 72;
  document.getElementById('modal-song-audio-file').textContent = song.audioFileName || 'Procedural Synth';
  
  const actualLyrics = song.lyrics || song.lines || [];
  document.getElementById('modal-song-lyrics-count').textContent = `${actualLyrics.length} lines`;

  // Store active target song ID in attribute
  document.getElementById('modal-song-save-btn').setAttribute('data-target-id', songId);

  const modal = document.getElementById('song-details-edit-modal');
  modal.classList.remove('hidden');
  modal.classList.add('flex');
  
  closeAllSongDropdowns();
}

function closeSongDetailsEditModal() {
  const modal = document.getElementById('song-details-edit-modal');
  modal.classList.add('hidden');
  modal.classList.remove('flex');
}

async function saveSongDetailsEditFromModal() {
  const songId = document.getElementById('modal-song-save-btn').getAttribute('data-target-id');
  if (!songId) return;

  const song = databaseSongs.find(s => s.id === songId);
  if (!song) return;

  const newTitle = document.getElementById('modal-song-title-input').value.trim();
  const newArtist = document.getElementById('modal-song-artist-input').value.trim();
  const newKey = document.getElementById('modal-song-key-select').value;
  const newTempo = parseInt(document.getElementById('modal-song-tempo-input').value) || 72;

  if (!newTitle) {
    alert("Please enter a valid song title.");
    return;
  }

  // Update memory
  song.title = newTitle;
  song.artist = newArtist || 'Worship Choir';
  song.key = newKey;
  song.tempo = newTempo;

  // Persist locally
  localStorage.setItem('sovereign_prompter_db', JSON.stringify(databaseSongs));
  updateDashboardStats();
  await renderSongsGrid();

  // Sync back to Firebase Firestore
  if (window.db && window.fStore) {
    const docRef = window.fStore.doc(window.db, "worship_songs", songId);
    try {
      await window.fStore.setDoc(docRef, song, { merge: true });
      console.log("Firestore background sync completed successfully for doc ID:", songId);
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `worship_songs/${songId}`);
    }
  }

  closeSongDetailsEditModal();
}

// Exposed globally for onclick interactions
window.toggleSongDropdown = toggleSongDropdown;
window.closeAllSongDropdowns = closeAllSongDropdowns;
window.openSongDetailsEditModal = openSongDetailsEditModal;
window.closeSongDetailsEditModal = closeSongDetailsEditModal;
window.saveSongDetailsEditFromModal = saveSongDetailsEditFromModal;

async function renderSongsGrid() {
  const grid = document.getElementById('songs-loop-grid');
  const searchFilter = document.getElementById('song-search-filter');
  const search = searchFilter ? searchFilter.value.toLowerCase() : '';
  
  if (!grid) return;
  grid.innerHTML = '';

  const filtered = databaseSongs.filter(song => 
    song.title.toLowerCase().includes(search) || 
    song.artist.toLowerCase().includes(search)
  );

  if (filtered.length === 0) {
    grid.innerHTML = `
      <div class="col-span-1 md:col-span-2 text-center py-16 border border-dashed border-neutral-850 rounded-2xl bg-neutral-950/10">
        <i data-lucide="music" class="w-12 h-12 text-neutral-650 mx-auto mb-4"></i>
        <p class="text-neutral-400 font-semibold text-lg">No worship songs matched your search</p>
        <p class="text-neutral-600 text-sm mt-1">Try typing a different name or navigate to Create Song to add a custom track.</p>
      </div>
    `;
    lucide.createIcons();
    return;
  }

  filtered.forEach(song => {
    const actualLyrics = song.lyrics || song.lines || [];
    const lastLyricTime = actualLyrics.length > 0 ? Math.max(...actualLyrics.map(l => l.time)) : 0;
    const durationEst = formatTimestamp(lastLyricTime + 10);

    const card = document.createElement('div');
    card.className = "worship-card-glowing rounded-2xl p-5 flex flex-col justify-between hover:shadow-xl transition relative group";
    card.innerHTML = `
      <div class="flex gap-4 items-start">
        <div class="p-3 bg-neutral-900 rounded-xl text-emerald-400 border border-neutral-850 group-hover:bg-emerald-500/5 group-hover:border-emerald-500/20 transition duration-300">
          <i data-lucide="music" class="w-6 h-6"></i>
        </div>
        
        <div class="space-y-1 flex-grow min-w-0">
          <h3 class="font-extrabold text-neutral-200 text-base md:text-lg tracking-tight leading-snug truncate">
            ${song.title}
          </h3>
          <div class="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-neutral-500 font-semibold">
            <span class="text-neutral-300 font-bold">${song.artist}</span>
            <span>•</span>
            <span class="font-mono">${actualLyrics.length} lines</span>
            <span>•</span>
            <span class="font-mono">${durationEst} est</span>
          </div>

          <!-- Metadata Info Badges -->
          <div class="flex flex-wrap gap-1.5 pt-2">
            <span class="text-[9px] font-bold font-mono tracking-wider bg-neutral-910 px-2.5 py-0.5 rounded border border-neutral-850 text-emerald-400/80 uppercase">
              Key: ${song.key || 'G'}
            </span>
            <span class="text-[9px] font-bold font-mono tracking-wider bg-neutral-910 px-2.5 py-0.5 rounded border border-neutral-850 text-neutral-400 uppercase">
              ${song.tempo || 72} BPM
            </span>
            <span class="text-[9px] font-bold font-mono tracking-wider bg-neutral-910 px-2.5 py-0.5 rounded border border-neutral-850 text-neutral-400 uppercase flex items-center gap-1 max-w-[160px] truncate">
              <i data-lucide="file-audio" class="w-2.5 h-2.5"></i>
              ${song.audioFileName || 'Procedural Synth'}
            </span>
          </div>
        </div>
      </div>

      <div class="flex items-center justify-between mt-6 pt-4 border-t border-neutral-900/60 font-semibold text-xs text-neutral-400 shrink-0 relative">
        <div class="flex items-center gap-1.5 relative">
          <!-- Elegant 3-dots options button -->
          <button
            onclick="toggleSongDropdown(event, '${song.id}')"
            class="p-2.5 bg-neutral-900 hover:bg-neutral-850 text-neutral-400 hover:text-emerald-400 rounded-lg border border-neutral-800/80 transition cursor-pointer relative"
            title="Song Options"
          >
            <i data-lucide="more-horizontal" class="w-4 h-4"></i>
          </button>

          <!-- Floating Dropdown Menu -->
          <div
            id="dropdown-menu-${song.id}"
            class="hidden absolute bottom-12 left-0 w-52 bg-neutral-950 border border-neutral-850 rounded-2xl shadow-2xl py-2 z-50 animate-in fade-in slide-in-from-bottom-2 duration-150"
            onclick="event.stopPropagation()"
          >
            <button
              onclick="loadSongIntoWizard('${song.id}')"
              class="w-full flex items-center gap-2.5 px-4 py-2.5 text-left text-neutral-300 hover:text-emerald-400 hover:bg-neutral-900 transition text-xs font-bold"
            >
              <i data-lucide="keyboard" class="w-4 h-4"></i>
              Timestamp Edit
            </button>

            <button
              onclick="openSongDetailsEditModal('${song.id}')"
              class="w-full flex items-center gap-2.5 px-4 py-2.5 text-left text-neutral-300 hover:text-emerald-400 hover:bg-neutral-900 transition text-xs font-bold"
            >
              <i data-lucide="sliders" class="w-4 h-4"></i>
              Rename &amp; Details
            </button>

            <div class="border-t border-neutral-900 my-1"></div>

            <button
              onclick="deleteSongFromDatabase('${song.id}')"
              class="w-full flex items-center gap-2.5 px-4 py-2.5 text-left text-red-500/80 hover:text-red-400 hover:bg-red-500/5 transition text-xs font-bold ${song.isPreloaded ? 'hidden' : ''}"
            >
              <i data-lucide="trash-2" class="w-4 h-4 text-red-500/70"></i>
              Delete Track
            </button>
          </div>
        </div>

        <button
          onclick="startPerformanceSession('${song.id}')"
          class="inline-flex items-center gap-1.5 px-4.5 py-2.5 bg-emerald-500 hover:bg-emerald-400 text-neutral-950 font-black rounded-xl transition text-xs shadow-lg cursor-pointer"
        >
          <i data-lucide="play" class="w-3.5 h-3.5 fill-current"></i>
          START WORSHIP
        </button>
      </div>
    `;
    grid.appendChild(card);
  });

  lucide.createIcons();
}

async function downloadSongToCache(songId, btnEl) {
  const song = databaseSongs.find(s => s.id === songId);
  if (!song) return;

  const originalHtml = btnEl ? btnEl.innerHTML : 'Download';
  if (btnEl) {
    btnEl.disabled = true;
    btnEl.innerHTML = `<i class="animate-spin w-3 h-3 rounded-full border border-neutral-950 border-t-transparent inline-block mr-1"></i> Saving...`;
  }

  try {
    if (!song.audioUrl) {
      throw new Error("No URL or local file path provided for this song.");
    }
    
    // Check if it's an expired blob URL or similar
    if (song.audioUrl.startsWith('blob:')) {
      throw new Error("The original session upload URL has expired.");
    }

    const response = await fetch(song.audioUrl);
    if (!response.ok) throw new Error(`HTTP Error ${response.status}`);
    const blob = await response.blob();
    await saveAudioToOfflineCache(songId, blob);
    await renderSongsGrid();
  } catch (error) {
    console.warn("Song download notification:", error.message || error);
    
    // Display a beautiful confirmation modal to let the user pick their own file
    const pickFile = await showConfirm(
      "Audio Track Source Needed",
      `The track's audio link could not be downloaded automatically (${error.message}). Would you like to select an audio file (MP3/WAV) from your device to save it to your offline cache instead?`,
      { confirmText: "Select Local Audio", isDanger: false }
    );
    
    if (pickFile) {
      // Programmatically open file input select on the client
      const fileInput = document.createElement('input');
      fileInput.type = 'file';
      fileInput.accept = 'audio/*';
      
      fileInput.onchange = async (e) => {
        const file = e.target.files[0];
        if (file) {
          if (btnEl) {
            btnEl.innerHTML = `<i class="animate-spin w-3 h-3 rounded-full border border-neutral-950 border-t-transparent inline-block mr-1"></i> Saving...`;
          }
          try {
            await saveAudioToOfflineCache(songId, file);
            
            // Also update the song metadata in our local and shared state to reflect this file's name
            song.audioFileName = file.name;
            const localCacheIdx = databaseSongs.findIndex(s => s.id === songId);
            if (localCacheIdx !== -1) {
              databaseSongs[localCacheIdx].audioFileName = file.name;
              localStorage.setItem('sovereign_prompter_db', JSON.stringify(databaseSongs));
            }
            
            // If Firestore is active, sync up the updated audio-file info
            if (window.db && window.fStore) {
              const docRef = window.fStore.doc(window.db, "worship_songs", songId);
              try {
                await window.fStore.setDoc(docRef, song, { merge: true });
              } catch (err) {
                handleFirestoreError(err, OperationType.WRITE, `worship_songs/${songId}`);
              }
            }
            
            await renderSongsGrid();
          } catch (err) {
            alert("Failed to save audio to cache: " + err.message);
          }
        }
        if (btnEl) {
          btnEl.disabled = false;
          btnEl.innerHTML = originalHtml;
        }
      };
      
      fileInput.click();
    } else {
      if (btnEl) {
        btnEl.disabled = false;
        btnEl.innerHTML = originalHtml;
      }
    }
  }
}

async function clearLocalCache(songId) {
  const confirmed = await showConfirm(
    "Clear Offline Audio Cache",
    "Are you sure you want to delete this audio file from your offline cache to free up disk space?",
    { confirmText: "Clear Cache", isDanger: true }
  );
  if (confirmed) {
    try {
      await deleteAudioFromOfflineCache(songId);
      await renderSongsGrid();
    } catch (e) {
      console.error(e);
      alert("Failed to clear cache: " + e.message);
    }
  }
}

async function deleteSongFromDatabase(id) {
  const confirmed = await showConfirm(
    "Permanently Delete Song",
    "Are you sure you want to permanently delete this worship track from both Cloud and Local state?",
    { confirmText: "Delete Permanently", isDanger: true }
  );
  if (confirmed) {
    try {
      // Eager offline-first deletion from local memory and LocalStorage
      databaseSongs = databaseSongs.filter(s => s.id !== id);
      localStorage.setItem('sovereign_prompter_db', JSON.stringify(databaseSongs));
      updateDashboardStats();
      await renderSongsGrid();

      // Clear the offline cache for this audio
      try {
        await deleteAudioFromOfflineCache(id);
      } catch (err) {
        console.warn("Local offline cache deletion ignored or already vanished:", err);
      }

      // Perform database doc deletion in Cloud Firestore asynchronously
      if (window.db && window.fStore) {
        const docRef = window.fStore.doc(window.db, "worship_songs", id);
        try {
          await window.fStore.deleteDoc(docRef);
          console.log("Deleted song successfully from Cloud Firestore:", id);
        } catch (error) {
          handleFirestoreError(error, OperationType.DELETE, `worship_songs/${id}`);
        }
      }
    } catch (e) {
      console.error(e);
      alert("Failed to delete song: " + e.message);
    }
  }
}

// Export song data structure as physical JSON file so children can keep copy offline directly inside local "database/" folder!
function downloadSongJson(id) {
  const song = databaseSongs.find(s => s.id === id);
  if (!song) return;

  const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(song, null, 2));
  const downloadAnchor = document.createElement('a');
  downloadAnchor.setAttribute("href", dataStr);
  downloadAnchor.setAttribute("download", `${song.title.toLowerCase().replace(/[^a-z0-9]+/g, '_')}.json`);
  document.body.appendChild(downloadAnchor);
  downloadAnchor.click();
  downloadAnchor.remove();
}

// ==================== SCREEN 2 LOGIC: CREATION WIZARD ====================
function initNewSongWizard() {
  editingSongId = null;
  document.getElementById('wizard-view-header').innerHTML = `<i data-lucide="sparkles" class="text-emerald-400"></i> New Worship Song`;
  
  // Default values
  document.getElementById('form-song-title').value = '';
  document.getElementById('form-song-artist').value = 'Worship Choir';
  document.getElementById('form-song-key').value = 'G Major';
  document.getElementById('form-song-tempo').value = 72;
  document.getElementById('form-raw-lyrics').value = `[Intro Keyboard - Focus and Prepare]\nAmazing Grace, how sweet the sound\nThat saved a wretch like me!\nI once was lost, but now am found\nWas blind but now I see.\n[Selah - Gentle instrument interlude]`;
  document.getElementById('form-song-audio-path').value = 'database/amazing_grace.mp3';
  
  wizardRawFile = null;
  wizardAudioUrl = '';
  wizardAudioFileName = '';
  document.getElementById('wizard-file-status-text').textContent = 'Browse local MP3 / WAV';
  document.getElementById('wizard-file-status-text').className = 'text-[11px] text-neutral-400 block truncate';
  
  toggleWizardAudioSource(true);
  switchView('wizard');
  switchOffsetWorkspace(false); // config phase first
}

function loadSongIntoWizard(id) {
  const song = databaseSongs.find(s => s.id === id);
  if (!song) return;

  editingSongId = song.id;
  document.getElementById('wizard-view-header').innerHTML = `<i data-lucide="edit-3" class="text-emerald-400"></i> Edit &amp; Timestamps Offset`;

  document.getElementById('form-song-title').value = song.title;
  document.getElementById('form-song-artist').value = song.artist || '';
  document.getElementById('form-song-key').value = song.key || 'G Major';
  document.getElementById('form-song-tempo').value = song.tempo || 72;
  document.getElementById('form-song-audio-path').value = song.audioUrl || '';
  
  // Extract raw text lines
  const songLyrics = song.lyrics || song.lines || [];
  const lyricLines = songLyrics.map(l => {
    if (l.time > 0) {
      return `${Math.round(l.time)}: ${l.text}`;
    }
    return l.text;
  }).join('\n');
  document.getElementById('form-raw-lyrics').value = lyricLines;

  wizardRawFile = null;
  wizardAudioUrl = song.audioUrl || '';
  wizardAudioFileName = song.audioFileName || '';

  if (song.audioUrl) {
    toggleWizardAudioSource(false);
    const displayFile = song.audioFileName || 'Pre-attached Track';
    document.getElementById('wizard-file-status-text').textContent = 'Assigned: ' + displayFile;
    document.getElementById('wizard-file-status-text').className = 'text-[11px] text-emerald-400 font-bold block truncate';
  } else {
    toggleWizardAudioSource(true);
    document.getElementById('wizard-file-status-text').textContent = 'Browse local MP3 / WAV';
    document.getElementById('wizard-file-status-text').className = 'text-[11px] text-neutral-400 block truncate';
  }

  switchView('wizard');
  switchOffsetWorkspace(false);
}

function toggleWizardAudioSource(isSynth) {
  wizardUseSynth = isSynth;
  const btnSynth = document.getElementById('btn-source-synth');
  const btnFile = document.getElementById('btn-source-file');
  const descSynth = document.getElementById('source-desc-synth');
  const descFile = document.getElementById('source-desc-file');

  if (isSynth) {
    btnSynth.classList.add('bg-emerald-500', 'text-neutral-950');
    btnSynth.classList.remove('text-neutral-450', 'text-neutral-500');
    btnFile.classList.add('text-neutral-500');
    btnFile.classList.remove('bg-emerald-500', 'text-neutral-950');
    descSynth.classList.remove('hidden');
    descFile.classList.add('hidden');
  } else {
    btnFile.classList.add('bg-emerald-500', 'text-neutral-950');
    btnFile.classList.remove('text-neutral-450', 'text-neutral-500');
    btnSynth.classList.add('text-neutral-500');
    btnSynth.classList.remove('bg-emerald-500', 'text-neutral-950');
    descFile.classList.remove('hidden');
    descSynth.classList.add('hidden');
  }
  lucide.createIcons();
}

function handleWizardFileSelected(input) {
  if (input.files && input.files[0]) {
    const file = input.files[0];
    wizardRawFile = file;
    wizardAudioFileName = file.name;
    wizardAudioUrl = URL.createObjectURL(file);
    document.getElementById('wizard-file-status-text').textContent = 'Loaded: ' + file.name;
    document.getElementById('wizard-file-status-text').className = 'text-[11px] text-emerald-400 font-bold block truncate';
  }
}

// Toggle workspaces inside wizard
function switchOffsetWorkspace(isSyncActive) {
  const configPanel = document.getElementById('wizard-phase-config');
  const syncPanel = document.getElementById('wizard-phase-sync');
  
  if (isSyncActive) {
    configPanel.classList.add('hidden');
    syncPanel.classList.remove('hidden');
  } else {
    configPanel.classList.remove('hidden');
    syncPanel.classList.add('hidden');
    stopAllWorshipAudio();
  }
}

// Initialize Sync Engine variables from raw lyrics box
async function initSyncEnginePhase() {
  const title = document.getElementById('form-song-title').value.trim();
  if (!title) {
    alert('Please fill in a Worship Song Title first.');
    return;
  }

  const lyricsRaw = document.getElementById('form-raw-lyrics').value.trim();
  if (!lyricsRaw) {
    alert('Please paste some lyrics raw rows to sync.');
    return;
  }

  const rawRows = lyricsRaw.split('\n').map(r => r.trim()).filter(r => r !== '');
  
  // Parse each line, honoring manual timestamp definitions like "1:15: Lyric" or "75: Lyric"
  wizardSyncedLyricsArray = rawRows.map((text, idx) => {
    const parsed = parseLyricLine(text, idx);
    return {
      id: 'lyr-' + idx + '-' + Date.now(),
      time: parsed.time,
      text: parsed.text
    };
  });

  wizardActiveSyncIndex = 0;
  wizardCurrentTime = 0;

  // Select row list populate
  const selector = document.getElementById('wizard-sync-select-row');
  selector.innerHTML = '';
  wizardSyncedLyricsArray.forEach((_, idx) => {
    const opt = document.createElement('option');
    opt.value = idx;
    opt.textContent = `Line ${idx + 1}`;
    selector.appendChild(opt);
  });

  // Headers update
  document.getElementById('wizard-sync-title').textContent = title;
  document.getElementById('wizard-sync-source-badge').textContent = wizardUseSynth ? 'USING PROCEDURAL PIANO SYNTH' : 'INSTRUMENTAL MP3 CLIENT';

  // Setup audio playback url
  if (!wizardUseSynth) {
    let resolvedSrc = '';
    if (editingSongId) {
      try {
        const cachedBlob = await getAudioFromOfflineCache(editingSongId);
        if (cachedBlob) {
          resolvedSrc = URL.createObjectURL(cachedBlob);
          console.log("Sync engine wizard successfully loaded pre-cached audio from local IndexedDB storage!");
        }
      } catch (err) {
        console.warn("Could not retrieve pre-cached audio from offline IndexedDB:", err);
      }
    }

    if (!resolvedSrc) {
      const manualPath = document.getElementById('form-song-audio-path').value.trim();
      resolvedSrc = wizardAudioUrl ? wizardAudioUrl : manualPath;
    }
    
    wizardAudioTag.src = resolvedSrc;
  }

  switchOffsetWorkspace(true);
  updateSyncPrompterFocus();
  renderInteractiveTimelineList();
}

function updateSyncPrompterFocus() {
  const prevEl = document.getElementById('sync-lyrics-prev');
  const activeEl = document.getElementById('sync-lyrics-active');
  const nextEl = document.getElementById('sync-lyrics-next');
  const counterEl = document.getElementById('wizard-sync-counter');

  counterEl.textContent = `${wizardActiveSyncIndex} / ${wizardSyncedLyricsArray.length} Rows Synced`;

  prevEl.textContent = wizardActiveSyncIndex > 0 ? wizardSyncedLyricsArray[wizardActiveSyncIndex - 1].text : '[Starting Point]';
  
  if (wizardActiveSyncIndex < wizardSyncedLyricsArray.length) {
    activeEl.textContent = wizardSyncedLyricsArray[wizardActiveSyncIndex].text;
    activeEl.classList.remove('text-neutral-500', 'italic');
    activeEl.classList.add('text-emerald-400');
    
    nextEl.textContent = wizardActiveSyncIndex < wizardSyncedLyricsArray.length - 1 ? wizardSyncedLyricsArray[wizardActiveSyncIndex + 1].text : '[Ending Point]';
  } else {
    activeEl.textContent = '🎉 All stamps configured perfectly! Feel free to manually edit timing below or save.';
    activeEl.classList.remove('text-emerald-400');
    activeEl.classList.add('text-neutral-500', 'italic');
    nextEl.textContent = '';
  }

  document.getElementById('wizard-sync-select-row').value = Math.min(wizardActiveSyncIndex, wizardSyncedLyricsArray.length - 1);
}

function jumpWizardActiveSyncIndex(idx) {
  wizardActiveSyncIndex = parseInt(idx);
  updateSyncPrompterFocus();
}

let wizardVolume = 0.8;
let draggedIdx = null;

function setWizardVolume(val) {
  wizardVolume = parseFloat(val);
  if (isNaN(wizardVolume)) wizardVolume = 0.8;
  
  if (wizardAudioTag) {
    wizardAudioTag.volume = wizardVolume;
  }
  
  if (synthGainNode && synthCtx) {
    try {
      synthGainNode.gain.setValueAtTime(0.16 * wizardVolume, synthCtx.currentTime);
    } catch (e) {}
  }
  
  const label = document.getElementById('wizard-sync-volume-val');
  if (label) {
    label.textContent = Math.round(wizardVolume * 100) + '%';
  }
}

function addNewWizardLine() {
  const txt = prompt("Enter text for the new lyric line:", "New Worship Lyric Line");
  if (txt !== null && txt.trim() !== '') {
    const newId = 'l-new-' + Date.now() + '-' + Math.floor(Math.random() * 1000);
    const initialTime = Math.round(wizardCurrentTime * 10) / 10;
    
    // Add inside wizard array
    wizardSyncedLyricsArray.push({
      id: newId,
      time: initialTime,
      text: txt.trim()
    });
    
    // Re-render, reset selection indexes and flash preview
    renderInteractiveTimelineList();
    updateSyncPrompterFocus();
    
    setTimeout(() => {
      const container = document.getElementById('sync-interactive-timeline-rows');
      if (container) {
        container.scrollTop = container.scrollHeight;
      }
    }, 80);
  }
}

function updateWizardItemText(idx, val) {
  if (wizardSyncedLyricsArray[idx]) {
    wizardSyncedLyricsArray[idx].text = val.trim();
    updateSyncPrompterFocus();
  }
}

function deleteWizardLine(idx) {
  if (wizardSyncedLyricsArray.length <= 1) {
    alert("You must keep at least one lyric line row!");
    return;
  }
  wizardSyncedLyricsArray.splice(idx, 1);
  if (wizardActiveSyncIndex >= wizardSyncedLyricsArray.length) {
    wizardActiveSyncIndex = wizardSyncedLyricsArray.length - 1;
  }
  renderInteractiveTimelineList();
  updateSyncPrompterFocus();
}

// Renders timeline adjustment scroll list items with drag-and-drop support
function renderInteractiveTimelineList() {
  const container = document.getElementById('sync-interactive-timeline-rows');
  if (!container) return;
  container.innerHTML = '';

  wizardSyncedLyricsArray.forEach((line, idx) => {
    const isActive = idx === wizardActiveSyncIndex;
    const row = document.createElement('div');
    row.id = `wizard-active-row-${idx}`;
    row.className = `p-3 bg-neutral-920 rounded-xl border text-left flex items-center justify-between gap-3 transition cursor-default ${isActive ? 'bg-emerald-500/10 border-emerald-500/30' : 'border-neutral-850'}`;
    
    row.draggable = true;
    
    row.addEventListener('dragstart', (e) => {
      draggedIdx = idx;
      e.dataTransfer.effectAllowed = 'move';
      row.classList.add('opacity-40');
      e.dataTransfer.setData('text/plain', idx);
    });
    
    row.addEventListener('dragend', () => {
      row.classList.remove('opacity-40');
      draggedIdx = null;
      const rows = container.querySelectorAll('[id^="wizard-active-row-"]');
      rows.forEach(r => r.classList.remove('border-emerald-500/50', 'bg-neutral-850/50'));
    });
    
    row.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      return false;
    });
    
    row.addEventListener('dragenter', () => {
      if (draggedIdx !== idx) {
        row.classList.add('border-emerald-500/50', 'bg-neutral-850/50');
      }
    });
    
    row.addEventListener('dragleave', () => {
      row.classList.remove('border-emerald-500/50', 'bg-neutral-850/50');
    });
    
    row.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      row.classList.remove('border-emerald-500/50', 'bg-neutral-850/50');
      
      if (draggedIdx !== null && draggedIdx !== idx) {
        const movedItem = wizardSyncedLyricsArray[draggedIdx];
        wizardSyncedLyricsArray.splice(draggedIdx, 1);
        wizardSyncedLyricsArray.splice(idx, 0, movedItem);
        
        if (wizardActiveSyncIndex === draggedIdx) {
          wizardActiveSyncIndex = idx;
        } else if (draggedIdx < wizardActiveSyncIndex && idx >= wizardActiveSyncIndex) {
          wizardActiveSyncIndex--;
        } else if (draggedIdx > wizardActiveSyncIndex && idx <= wizardActiveSyncIndex) {
          wizardActiveSyncIndex++;
        }
        
        renderInteractiveTimelineList();
        updateSyncPrompterFocus();
      }
    });

    row.innerHTML = `
      <div class="cursor-grab active:cursor-grabbing p-1 text-neutral-600 hover:text-neutral-400 self-center shrink-0">
        <i data-lucide="grip-vertical" class="w-3.5 h-3.5"></i>
      </div>

      <div class="flex-grow min-w-0">
        <div class="flex items-center gap-2 text-[9px] font-mono text-neutral-500 font-bold">
          <span>ROW ${idx + 1}</span>
          ${line.time > 0 ? `<button onclick="seekWizardTrackTo(${line.time})" class="text-emerald-400 hover:underline">Audition from ${line.time}s</button>` : ''}
        </div>
        <input
          type="text"
          value="${line.text.replace(/"/g, '&quot;')}"
          onchange="updateWizardItemText(${idx}, this.value)"
          class="bg-transparent border-b border-transparent hover:border-neutral-800 focus:border-emerald-500/40 focus:outline-none text-xs text-neutral-300 w-full font-semibold focus:text-white pt-1"
        />
      </div>

      <div class="flex items-center gap-1.5 shrink-0">
        <input
          type="number"
          step="0.1"
          min="0"
          value="${line.time}"
          onchange="updateWizardItemTime(${idx}, this.value)"
          class="bg-neutral-910 border border-neutral-805 rounded px-2 py-0.5 text-xs text-white font-mono w-16 text-center focus:outline-none focus:border-emerald-500"
        >
        <span class="text-[9px] text-neutral-500 font-mono">s</span>

        <button
          onclick="deleteWizardLine(${idx})"
          class="p-1 hover:bg-neutral-850 hover:text-red-400 text-neutral-600 rounded transition cursor-pointer"
          title="Delete this row"
        >
          <i data-lucide="trash-2" class="w-3.5 h-3.5"></i>
        </button>
      </div>
    `;
    container.appendChild(row);
  });

  if (window.lucide) {
    window.lucide.createIcons();
  }
}

function updateWizardItemTime(idx, val) {
  const parsed = parseFloat(val);
  if (!isNaN(parsed) && parsed >= 0) {
    wizardSyncedLyricsArray[idx].time = Math.round(parsed * 10) / 10;
    renderInteractiveTimelineList();
  }
}

function seekWizardTrackTo(time) {
  wizardCurrentTime = Math.max(0, Math.min(wizardDuration, time));
  if (!wizardUseSynth) {
    wizardAudioTag.currentTime = wizardCurrentTime;
  }
  document.getElementById('wizard-sync-curr-time').textContent = formatTimestamp(wizardCurrentTime);
  
  const percent = Math.min(100, (wizardCurrentTime / wizardDuration) * 100);
  const progressBar = document.getElementById('wizard-sync-timeline-progress');
  if (progressBar) {
    progressBar.style.width = percent + '%';
  }

  // Locate matched index that corresponds to the seeked time
  let matchedIndex = 0;
  for (let i = 0; i < wizardSyncedLyricsArray.length; i++) {
    if (wizardSyncedLyricsArray[i].time <= wizardCurrentTime) {
      matchedIndex = i;
    } else {
      break;
    }
  }
  wizardActiveSyncIndex = matchedIndex;
  
  updateSyncPrompterFocus();
  renderInteractiveTimelineList();

  const activeRow = document.getElementById(`wizard-active-row-${wizardActiveSyncIndex}`);
  if (activeRow) {
    activeRow.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

function handleWizardTimelineClick(event) {
  const container = document.getElementById('wizard-sync-timeline-container');
  if (!container) return;
  const rect = container.getBoundingClientRect();
  const clickX = event.clientX - rect.left;
  const percentage = Math.max(0, Math.min(1, clickX / rect.width));
  const targetTime = percentage * (wizardDuration || 120);
  seekWizardTrackTo(targetTime);
}


// Toggle live audio play inside wizard sync workspace
function toggleWizardSyncPlayback() {
  if (wizardIsPlaying) {
    wizardIsPlaying = false;
    clearInterval(wizardIntervalId);
    if (wizardUseSynth) {
      stopProceduralSynthPad();
    } else {
      try { wizardAudioTag.pause(); } catch(e){}
    }
    document.getElementById('wizard-sync-play-btn').innerHTML = `<i data-lucide="play" class="w-3.5 h-3.5 fill-current"></i> PLAY DEMO TRACK`;
    lucide.createIcons();
  } else {
    wizardIsPlaying = true;
    
    if (wizardCurrentTime >= wizardDuration) {
      wizardCurrentTime = 0;
      if (!wizardUseSynth) { wizardAudioTag.currentTime = 0; }
    }

    if (wizardUseSynth) {
      wizardDuration = Math.max(120, wizardSyncedLyricsArray.length * 7.5);
      startProceduralSynthPad(72);
    } else {
      wizardDuration = wizardAudioTag.duration || 120;
      wizardAudioTag.play().catch(e => {
        console.warn("Local path loading fallback to keyboard synthesiser", e);
        wizardUseSynth = true;
        document.getElementById('wizard-sync-source-badge').textContent = 'FALLBACK PROCEDURAL PAD ACTIVE';
        startProceduralSynthPad(72);
      });
    }

    // Ticker update loop
    const tickRateMs = 100;
    wizardIntervalId = setInterval(() => {
      if (wizardUseSynth) {
        wizardCurrentTime += (tickRateMs / 1000);
      } else {
        wizardCurrentTime = wizardAudioTag.currentTime;
        wizardDuration = wizardAudioTag.duration || 120;
      }

      document.getElementById('wizard-sync-curr-time').textContent = formatTimestamp(wizardCurrentTime);
      document.getElementById('wizard-sync-duration').textContent = formatTimestamp(wizardDuration);
      
      const percent = Math.min(100, (wizardCurrentTime / wizardDuration) * 100);
      document.getElementById('wizard-sync-timeline-progress').style.width = percent + '%';

      if (wizardCurrentTime >= wizardDuration) {
        toggleWizardSyncPlayback();
      }
    }, tickRateMs);

    document.getElementById('wizard-sync-play-btn').innerHTML = `<i data-lucide="pause" class="w-3.5 h-3.5 fill-current"></i> PAUSE PLAYBACK`;
    lucide.createIcons();
  }
}

// Stamp event trigger
function triggerActiveLineStamp() {
  if (!wizardIsPlaying) {
    toggleWizardSyncPlayback();
  }

  if (wizardActiveSyncIndex >= wizardSyncedLyricsArray.length) {
    return;
  }

  playLocalHighChimeBell();

  wizardSyncedLyricsArray[wizardActiveSyncIndex].time = Math.round(wizardCurrentTime * 10) / 10;
  
  wizardActiveSyncIndex++;
  
  updateSyncPrompterFocus();
  renderInteractiveTimelineList();

  const rowItem = document.getElementById(`wizard-active-row-${Math.min(wizardActiveSyncIndex, wizardSyncedLyricsArray.length - 1)}`);
  if (rowItem) {
    rowItem.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

// Spacebar active listener key hook & prompt fullscreen toggle
window.addEventListener('keydown', (e) => {
  const tag = document.activeElement ? document.activeElement.tagName : '';
  if (tag === 'INPUT' || tag === 'TEXTAREA') {
    return;
  }

  const syncViewActive = document.getElementById('view-wizard').classList.contains('hidden') === false &&
                         document.getElementById('wizard-phase-sync').classList.contains('hidden') === false;
                         
  if (syncViewActive) {
    if (e.code === 'Space') {
      e.preventDefault();
      triggerActiveLineStamp();
    }
  }

  // Handle 'F' or 'f' shortcut to toggle player fullscreen view
  const playerView = document.getElementById('view-player');
  const playerViewActive = playerView && playerView.classList.contains('hidden') === false;
  if (playerViewActive) {
    if (e.key === 'f' || e.key === 'F') {
      e.preventDefault();
      togglePlayerFullscreen();
    }
  }
});

async function unstampAllLines() {
  const confirmed = await showConfirm(
    "Reset All Timings",
    "Are you sure you want to clean all timings back to 0.0s?",
    { confirmText: "Reset Timings", isDanger: true }
  );
  if (confirmed) {
    wizardSyncedLyricsArray = wizardSyncedLyricsArray.map(line => ({ ...line, time: 0.0 }));
    wizardActiveSyncIndex = 0;
    wizardCurrentTime = 0;
    if (!wizardUseSynth) {
      wizardAudioTag.currentTime = 0;
    }
    updateSyncPrompterFocus();
    renderInteractiveTimelineList();
  }
}

async function uploadAudioFileToStorage(file, slug) {
  if (!file) return '';
  const fileRef = window.fStorage.ref(window.storage, `songs/${slug}/${file.name}`);
  const snapshot = await window.fStorage.uploadBytes(fileRef, file);
  return await window.fStorage.getDownloadURL(snapshot.ref);
}

// Complete saving process
async function saveWorshipTrackToDatabase() {
  const title = document.getElementById('form-song-title').value.trim();
  const artist = document.getElementById('form-song-artist').value.trim();
  const key = document.getElementById('form-song-key').value;
  const tempo = parseInt(document.getElementById('form-song-tempo').value) || 72;
  const manualPath = document.getElementById('form-song-audio-path').value.trim();

  if (!title) {
    alert('Please fill out the Song Title.');
    return;
  }

  const saveBtn = document.querySelector('[onclick="saveWorshipTrackToDatabase()"]');
  const originalHtml = saveBtn ? saveBtn.innerHTML : 'SAVE & EXIT';
  if (saveBtn) {
    saveBtn.disabled = true;
    saveBtn.innerHTML = `<i class="animate-spin w-3.5 h-3.5 rounded-full border-2 border-neutral-950 border-t-transparent inline-block mr-1"></i> Saving...`;
  }

  try {
    const safeTitle = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'song';
    // If editing, preserve the ID; if new, compute slug + unique timestamp
    const docId = editingSongId ? editingSongId : `${safeTitle}-${Date.now()}`;

    // Cache locally in IndexedDB first so it's instantly available offline!
    if (!wizardUseSynth && wizardRawFile) {
      try {
        await saveAudioToOfflineCache(docId, wizardRawFile);
        console.log("Cached audio blob locally in IndexedDB:", docId);
      } catch (err) {
        console.warn("Failed to cache audio locally in IndexedDB:", err);
      }
    }

    let finalAudioUrl = wizardUseSynth ? '' : (wizardAudioUrl || manualPath);
    const sortedLyrics = [...wizardSyncedLyricsArray].sort((a,b) => a.time - b.time);

    const songObj = {
      id: docId,
      title: title,
      artist: artist || 'Family Choir',
      key: key,
      tempo: tempo,
      audioUrl: finalAudioUrl,
      audioFileName: wizardUseSynth ? 'Procedural Piano Synth' : (wizardRawFile ? wizardRawFile.name : (wizardAudioFileName || manualPath)),
      isPreloaded: false,
      lyrics: sortedLyrics,
      lines: sortedLyrics,
      updatedAt: Date.now()
    };

    // Update locally instantly for zero latency!
    if (editingSongId) {
      databaseSongs = databaseSongs.map(s => s.id === editingSongId ? songObj : s);
    } else {
      databaseSongs.push(songObj);
    }
    localStorage.setItem('sovereign_prompter_db', JSON.stringify(databaseSongs));

    // Instantly close the wizard view and return to dashboard
    switchView('dashboard');
    await renderSongsGrid();

    // Now push to Firebase Storage and Firestore in the background
    (async () => {
      try {
        if (!wizardUseSynth && wizardRawFile) {
          console.log("Background uploading file to Firebase Storage...", wizardRawFile.name);
          try {
            const uploadPromise = uploadAudioFileToStorage(wizardRawFile, docId);
            // 15 second timeout for background storage upload
            const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error("Storage upload timed out")), 15000));
            const remoteUrl = await Promise.race([uploadPromise, timeoutPromise]);
            
            songObj.audioUrl = remoteUrl;
            console.log("Background upload success: set remote URL to:", remoteUrl);
          } catch(e) {
            console.warn("Background upload to Firebase Storage bypassed (using offline index cache):", e);
          }
        }

        console.log("Background persisting track to Firestore under collection /worship_songs doc ID:", docId);
        const docRef = window.fStore.doc(window.db, "worship_songs", docId);
        try {
          await window.fStore.setDoc(docRef, songObj);
          console.log("Firestore background sync completed successfully for doc ID:", docId);
        } catch (err) {
          handleFirestoreError(err, OperationType.WRITE, `worship_songs/${docId}`);
        }
      } catch (err) {
        console.error("Firestore background sync failed:", err);
      }
    })();

  } catch (error) {
    console.error("Save failed:", error);
    alert("Worship Saved failed: " + error.message);
  } finally {
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.innerHTML = originalHtml;
    }
  }
}

// ==================== SCREEN 3 LOGIC: PERFORMANCE PLAYER ====================
async function startPerformanceSession(id) {
  const song = databaseSongs.find(s => s.id === id);
  if (!song) return;

  playingSong = song;
  playerIsPlaying = false;
  playerCurrentTime = 0;
  lastSpokenLyricIndex = -1;
  activePrompterIndex = -1;

  // Title displays
  document.getElementById('player-track-title').textContent = song.title;

  const playerAudio = document.getElementById('player-audio-source');
  const synthBadge = document.getElementById('player-synth-pad-on-badge');
  const volSliderWrap = document.getElementById('player-audio-vol-slider-wrap');

  // Trigger prompter rows update initially
  updatePrompterTextUI();

  let usingSource = 'AMBIENT PIANO SYNTH';

  if (song.audioUrl) {
    // 1. Check offline IndexedDB cache first
    let cachedBlob = null;
    try {
      cachedBlob = await getAudioFromOfflineCache(song.id);
    } catch (e) {
      console.warn("Error reading from offline IndexedDB cache:", e);
    }

    if (cachedBlob) {
      console.log("Playing audio from offline IndexedDB cache!");
      const objectUrl = URL.createObjectURL(cachedBlob);
      playerAudio.src = objectUrl;
      usingSource = 'OFFLINE CACHE (Permanent)';
    } else {
      console.log("Playing audio from Firebase Storage url:", song.audioUrl);
      playerAudio.src = song.audioUrl;
      usingSource = 'FIREBASE CLOUD STREAM (Online Only)';
    }

    playerAudio.load();
    playerDuration = 120;
    synthBadge.classList.add('hidden');
    volSliderWrap.classList.remove('hidden');
  } else {
    playerAudio.src = '';
    playerDuration = Math.max(120, songLyrics.length > 0 ? Math.max(...songLyrics.map(l => l.time)) + 12 : 120);
    synthBadge.classList.remove('hidden');
    volSliderWrap.classList.add('hidden');
  }

  document.getElementById('player-track-subtitle').textContent = `KEY: ${song.key || 'G'} • TEMPO: ${song.tempo || 72} BPM • SOURCE: ${usingSource}`;

  setPlayerTempoSpeed(1.0);
  switchView('player');
  initPlayerMotionWaveCanvas();

  // Make vocal assist muted by default on starting performance
  playerVocalAssist = true;
  togglePlayerVocalAssist(); // Sets it to false and configures MUTED class and label
}

function togglePlayerVocalAssist() {
  playerVocalAssist = !playerVocalAssist;
  const btn = document.getElementById('player-btn-assist');
  const status = document.getElementById('player-assist-status');
  
  if (playerVocalAssist) {
    btn.className = "px-3 py-1.5 bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 rounded-xl text-xs font-bold transition flex items-center gap-1.5 cursor-pointer shadow-[0_0_10px_rgba(16,185,129,0.1)]";
    status.textContent = 'ACTIVE';
  } else {
    btn.className = "px-3 py-1.5 bg-neutral-900 text-neutral-400 border border-neutral-800 rounded-xl text-xs font-bold transition flex items-center gap-1.5 cursor-pointer";
    status.textContent = 'MUTED';
    if (window.speechSynthesis) {
      window.speechSynthesis.cancel();
    }
  }
}

function togglePlayerFullscreen() {
  const player = document.getElementById('view-player');
  if (!player) return;
  
  const isCurrentlyNativeFs = !!(document.fullscreenElement === player || document.webkitFullscreenElement === player);
  const isCurrentlyClassFs = player.classList.contains('is-fullscreen');
  
  if (!isCurrentlyNativeFs && !isCurrentlyClassFs) {
    // Try native fullscreen request first
    const requestFs = player.requestFullscreen || player.webkitRequestFullscreen || player.mozRequestFullScreen || player.msRequestFullscreen;
    if (requestFs) {
      requestFs.call(player).catch(err => {
        console.warn(`Native requestFullscreen call failed, using custom CSS fullscreen class fallback: ${err.message}`);
        player.classList.add('is-fullscreen');
        handleFullscreenChange();
      });
    } else {
      player.classList.add('is-fullscreen');
      handleFullscreenChange();
    }
  } else {
    // Exit fullscreen
    if (isCurrentlyNativeFs) {
      const exitFs = document.exitFullscreen || document.webkitExitFullscreen || document.mozCancelFullScreen || document.msExitFullscreen;
      if (exitFs) {
        exitFs.call(document);
      }
    } else {
      player.classList.remove('is-fullscreen');
      handleFullscreenChange();
    }
  }
}

const handleFullscreenChange = () => {
  const player = document.getElementById('view-player');
  const btnIcon = document.getElementById('player-fullscreen-icon');
  const btnTxt = document.getElementById('player-fullscreen-text');
  if (!player) return;
  
  const isFs = !!(document.fullscreenElement === player || document.webkitFullscreenElement === player || player.classList.contains('is-fullscreen'));
  
  if (isFs) {
    player.classList.add('is-fullscreen');
    if (btnIcon) {
      btnIcon.setAttribute('data-lucide', 'minimize-2');
    }
    if (btnTxt) {
      btnTxt.textContent = 'Exit Full';
    }
  } else {
    player.classList.remove('is-fullscreen');
    if (btnIcon) {
      btnIcon.setAttribute('data-lucide', 'maximize-2');
    }
    if (btnTxt) {
      btnTxt.textContent = 'Fullscreen';
    }
  }
  if (window.lucide) {
    window.lucide.createIcons();
  }
};

document.addEventListener('fullscreenchange', handleFullscreenChange);
document.addEventListener('webkitfullscreenchange', handleFullscreenChange);
document.addEventListener('mozfullscreenchange', handleFullscreenChange);
document.addEventListener('MSFullscreenChange', handleFullscreenChange);

function stopPerformanceSession() {
  stopAllWorshipAudio();
  switchView('dashboard');
}

function togglePerformancePlayback() {
  const btn = document.getElementById('player-play-giant');
  const audioTag = document.getElementById('player-audio-source');

  if (playerIsPlaying) {
    playerIsPlaying = false;
    btn.innerHTML = `<i data-lucide="play" class="w-6 h-6 fill-current stroke-[2.5] ml-0.5"></i>`;
    
    if (playingSong.audioUrl) {
      try { audioTag.pause(); } catch(e){}
    } else {
      stopProceduralSynthPad();
    }

    if (window.speechSynthesis) {
      window.speechSynthesis.cancel();
    }
  } else {
    playerIsPlaying = true;
    btn.innerHTML = `<i data-lucide="pause" class="w-6 h-6 fill-current stroke-[2.5]"></i>`;

    if (playingSong.audioUrl) {
      audioTag.play().catch(err => {
        console.warn("Worship audio track error. Falling back to ambient synthesizer.", err);
        playingSong.audioUrl = ''; // dynamic fallback
        document.getElementById('player-synth-pad-on-badge').classList.remove('hidden');
        document.getElementById('player-audio-vol-slider-wrap').classList.add('hidden');
        startProceduralSynthPad(playingSong.tempo);
      });
    } else {
      startProceduralSynthPad(playingSong.tempo);
    }

    lastCpuStamp = Date.now();
    requestAnimationFrame(performanceProgressMasterTick);
  }
  lucide.createIcons();
}

let lastCpuStamp = Date.now();

function performanceProgressMasterTick() {
  if (!playerIsPlaying || activeView !== 'player') return;

  const audioTag = document.getElementById('player-audio-source');
  
  if (playingSong.audioUrl) {
    playerCurrentTime = audioTag.currentTime;
    playerDuration = audioTag.duration || 120;
  } else {
    const now = Date.now();
    const delta = (now - lastCpuStamp) / 1000;
    lastCpuStamp = now;
    playerCurrentTime += delta * playerPlaybackRate;
  }

  if (playerCurrentTime >= playerDuration) {
    playerCurrentTime = playerDuration;
    togglePerformancePlayback();
  }

  const progressInput = document.getElementById('player-time-progress');
  if (progressInput) {
    progressInput.max = playerDuration;
    progressInput.value = playerCurrentTime;
  }
  
  const currTimeLabel = document.getElementById('player-time-curr');
  if (currTimeLabel) currTimeLabel.textContent = formatTimeOnly(playerCurrentTime);
  
  const totalTimeLabel = document.getElementById('player-time-total');
  if (totalTimeLabel) totalTimeLabel.textContent = formatTimeOnly(playerDuration);

  // Locate matched index scanning the whole array to support re-ordered tracks or custom offsets
  let matchedIndex = -1;
  const lyrics = playingSong.lyrics || [];
  let maxTimeFound = -1;
  
  for (let i = 0; i < lyrics.length; i++) {
    const t = lyrics[i].time;
    if (t <= playerCurrentTime) {
      if (t > maxTimeFound) {
        maxTimeFound = t;
        matchedIndex = i;
      }
    }
  }

  if (matchedIndex !== activePrompterIndex) {
    activePrompterIndex = matchedIndex;
    updatePrompterTextUI();
  }

  triggerNeuralVocalGuideAssistant();

  if (playerIsPlaying) {
    requestAnimationFrame(performanceProgressMasterTick);
  }
}

function updatePrompterTextUI() {
  const lyrics = playingSong.lyrics || [];
  const prevEl = document.getElementById('prompt-row-prev');
  const activeEl = document.getElementById('prompt-row-active');
  const nextEl = document.getElementById('prompt-row-next');

  if (!activeEl) return;

  let prevLine = '';
  let activeLine = '[Get ready to sing - breath slow]';
  let nextLine = '';

  if (activePrompterIndex === -1) {
    prevLine = '• • •';
    activeLine = '[Get ready to sing - breath slow]';
    nextLine = lyrics[0] ? lyrics[0].text : '• • •';
  } else {
    prevLine = activePrompterIndex > 0 ? lyrics[activePrompterIndex - 1].text : '• • •';
    activeLine = lyrics[activePrompterIndex] ? lyrics[activePrompterIndex].text : '';
    nextLine = activePrompterIndex < lyrics.length - 1 ? lyrics[activePrompterIndex + 1].text : '• • •';
  }

  if (prevEl) prevEl.textContent = prevLine || '• • •';
  
  activeEl.textContent = activeLine || '[Get ready]';
  if (activeLine.startsWith('[')) {
    activeEl.className = "text-xl sm:text-2xl md:text-3.5xl font-bold tracking-normal italic text-neutral-500 filter drop-shadow-none transition duration-150";
  } else {
    activeEl.className = "text-3xl sm:text-4xl md:text-5xl lg:text-6.5xl font-black text-emerald-400 tracking-tight leading-normal filter neon-text-glow transition duration-150 transform scale-102";
  }

  if (nextEl) nextEl.textContent = nextLine || '• • •';
}

function triggerNeuralVocalGuideAssistant() {
  if (!playerVocalAssist || !playerIsPlaying) return;

  const lyrics = playingSong.lyrics || [];
  const upcomingIndex = activePrompterIndex + 1;
  
  if (upcomingIndex < lyrics.length) {
    const upcomingLine = lyrics[upcomingIndex];
    const anticipTime = upcomingLine.time - 2.5;

    if (playerCurrentTime >= anticipTime && lastSpokenLyricIndex < upcomingIndex) {
      lastSpokenLyricIndex = upcomingIndex;
      
      if (!upcomingLine.text.startsWith('[')) {
        speakSpeechUtteranceWord(upcomingLine.text);
      }
    }
  }
}

function speakSpeechUtteranceWord(text) {
  if (window.speechSynthesis) {
    window.speechSynthesis.cancel();
    
    const cleaned = text.replace(/[.,\/#!$%\^&\*;:{}=\-_`~()]/g, "");
    const msg = new SpeechSynthesisUtterance(cleaned);
    
    msg.volume = 0.5;
    msg.rate = 1.12; 
    msg.pitch = 1.05;

    window.speechSynthesis.speak(msg);
  }
}

function seekPlayerTimeTo(val) {
  const parsed = parseFloat(val);
  playerCurrentTime = parsed;
  
  if (playingSong.audioUrl) {
    const audioTag = document.getElementById('player-audio-source');
    audioTag.currentTime = parsed;
  }

  if (window.speechSynthesis) {
    window.speechSynthesis.cancel();
  }

  let matchedIndex = -1;
  let maxTimeFound = -1;
  const lyrics = playingSong.lyrics || [];
  for (let i = 0; i < lyrics.length; i++) {
    const t = lyrics[i].time;
    if (t <= playerCurrentTime) {
      if (t > maxTimeFound) {
        maxTimeFound = t;
        matchedIndex = i;
      }
    }
  }
  activePrompterIndex = matchedIndex;
  lastCpuStamp = Date.now();
  
  updatePrompterTextUI();
}

function setPlayerTempoSpeed(rate) {
  playerPlaybackRate = rate;
  
  const speeds = [0.8, 1.0, 1.2];
  speeds.forEach(sp => {
    const el = document.getElementById(`btn-speed-${sp.toString().replace('.', '')}`);
    if (el) {
      if (sp === rate) {
        el.className = "px-2.5 py-1 text-[10px] font-mono rounded-lg bg-emerald-500 text-neutral-950 font-bold transition cursor-pointer";
      } else {
        el.className = "px-2.5 py-1 text-[10px] font-mono rounded-lg text-neutral-400 font-bold hover:text-white transition cursor-pointer";
      }
    }
  });

  if (playingSong && playingSong.audioUrl) {
    const audioTag = document.getElementById('player-audio-source');
    audioTag.playbackRate = rate;
  }
}

function setPlayerAudioVolumeLevel(v) {
  playerVolume = parseFloat(v);
  const audioTag = document.getElementById('player-audio-source');
  if (audioTag) {
    audioTag.volume = playerVolume;
  }
}

function goToPrevPlayerLyricRow() {
  if (activePrompterIndex > 0) {
    const prevTime = playingSong.lyrics[activePrompterIndex - 1].time;
    seekPlayerTimeTo(prevTime);
  }
}

function goToNextPlayerLyricRow() {
  if (activePrompterIndex < playingSong.lyrics.length - 1) {
    const nextTime = playingSong.lyrics[activePrompterIndex + 1].time;
    seekPlayerTimeTo(nextTime);
  }
}

// ==================== PROCEDURAL WEB AUDIO SYNTHESIZER DRONE ====================
function startProceduralSynthPad(tempoBpm) {
  try {
    if (!synthCtx) {
      synthCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (synthCtx.state === 'suspended') {
      synthCtx.resume();
    }

    stopProceduralSynthPad();

    const baseC3 = 130.81; // C3 Warm fundamental major drone setup
    const fifthG3 = 196.00; // G3

    synthGainNode = synthCtx.createGain();
    synthGainNode.gain.setValueAtTime(0, synthCtx.currentTime);
    synthGainNode.gain.linearRampToValueAtTime(0.16, synthCtx.currentTime + 1.2);

    synthFilterNode = synthCtx.createBiquadFilter();
    synthFilterNode.type = 'lowpass';
    synthFilterNode.frequency.setValueAtTime(320, synthCtx.currentTime);
    synthFilterNode.Q.setValueAtTime(1.0, synthCtx.currentTime);

    const osc1 = synthCtx.createOscillator();
    osc1.type = 'triangle';
    osc1.frequency.setValueAtTime(baseC3, synthCtx.currentTime);

    const osc2 = synthCtx.createOscillator();
    osc2.type = 'sawtooth';
    osc2.frequency.setValueAtTime(fifthG3, synthCtx.currentTime);

    const oscSub = synthCtx.createOscillator();
    oscSub.type = 'sine';
    oscSub.frequency.setValueAtTime(baseC3 / 2, synthCtx.currentTime);

    const g1 = synthCtx.createGain();
    g1.gain.setValueAtTime(0.7, synthCtx.currentTime);
    const g2 = synthCtx.createGain();
    g2.gain.setValueAtTime(0.18, synthCtx.currentTime);
    const gSub = synthCtx.createGain();
    gSub.gain.setValueAtTime(0.4, synthCtx.currentTime);

    osc1.connect(g1);
    osc2.connect(g2);
    oscSub.connect(gSub);

    g1.connect(synthFilterNode);
    g2.connect(synthFilterNode);
    gSub.connect(synthFilterNode);

    synthFilterNode.connect(synthGainNode);
    synthGainNode.connect(synthCtx.destination);

    osc1.start();
    osc2.start();
    oscSub.start();

    synthOscs = [osc1, osc2, oscSub];

    synthIntervalId = setInterval(() => {
      if (synthCtx && synthFilterNode) {
        const now = synthCtx.currentTime;
        synthFilterNode.frequency.exponentialRampToValueAtTime(180 + Math.random() * 160, now + 3);
      }
    }, 4000);

  } catch (err) {
    console.warn("Could not activate Web Audio module:", err);
  }
}

function playLocalHighChimeBell() {
  if (!synthCtx) return;
  try {
    const osc = synthCtx.createOscillator();
    const gain = synthCtx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, synthCtx.currentTime);

    gain.gain.setValueAtTime(0.12, synthCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, synthCtx.currentTime + 0.8);

    osc.connect(gain);
    gain.connect(synthCtx.destination);
    osc.start();
    osc.stop(synthCtx.currentTime + 0.9);
  } catch(e){}
}

function stopProceduralSynthPad() {
  try {
    synthOscs.forEach(o => {
      try { o.stop(); } catch(e){}
    });
    synthOscs = [];
    if (synthIntervalId) {
      clearInterval(synthIntervalId);
    }
    if (synthGainNode && synthCtx) {
      synthGainNode.gain.exponentialRampToValueAtTime(0.001, synthCtx.currentTime + 0.4);
    }
  } catch(e){}
}

// ==================== PROCEDURAL CORE GRAPHICAL WAVE VISUALIZER ====================
let canvasAnimationId = null;
function initPlayerMotionWaveCanvas() {
  const canvas = document.getElementById('player-wave-canvas');
  if (!canvas) return;

  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const render = () => {
    if (activeView !== 'player') {
      cancelAnimationFrame(canvasAnimationId);
      return;
    }

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    
    const w = canvas.width;
    const h = canvas.height;
    const speed = playerIsPlaying ? (Date.now() / 400) * playerPlaybackRate : (Date.now() / 2500);
    const waveHeight = playerIsPlaying ? 28 : 4;

    ctx.lineWidth = 2.5;

    // Glowing front wave
    ctx.shadowBlur = 10;
    ctx.shadowColor = 'rgba(16, 185, 129, 0.5)';
    ctx.strokeStyle = 'rgba(16, 185, 129, 0.85)';
    ctx.beginPath();
    for (let x = 0; x < w; x++) {
      const y = h / 2 + Math.sin(x * 0.012 + speed) * Math.cos(x * 0.004 + speed * 0.4) * waveHeight;
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Secondary back background wave
    ctx.shadowBlur = 0;
    ctx.strokeStyle = 'rgba(16, 185, 129, 0.2)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let x = 0; x < w; x++) {
      const y = h / 2 + Math.sin(x * 0.008 - speed * 0.6) * (waveHeight * 0.6);
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    canvasAnimationId = requestAnimationFrame(render);
  };

  render();
}

// ==================== COMMON TIMING UTILS ====================
function formatTimestamp(totalSec) {
  const mins = Math.floor(totalSec / 60);
  const secs = (totalSec % 60).toFixed(1);
  return `${mins}:${secs.padStart(4, '0')}`;
}

function formatTimeOnly(totalSec) {
  const mins = Math.floor(totalSec / 60);
  const secs = Math.floor(totalSec % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

let confirmCallback = null;

function showConfirm(title, message, options = {}) {
  return new Promise((resolve) => {
    confirmCallback = resolve;
    const modal = document.getElementById('custom-confirm-modal');
    if (!modal) {
      resolve(confirm(message));
      return;
    }
    document.getElementById('confirm-modal-title').textContent = title || "Confirm Action";
    document.getElementById('confirm-modal-message').textContent = message || "Are you sure you want to proceed?";
    
    const actionBtn = document.getElementById('confirm-modal-action-btn');
    if (actionBtn) {
      actionBtn.textContent = options.confirmText || "Confirm";
      if (options.isDanger) {
        actionBtn.className = "px-5 py-2 bg-red-500 hover:bg-red-400 text-neutral-950 font-black text-xs rounded-xl transition cursor-pointer shadow-lg shadow-red-500/10";
      } else {
        actionBtn.className = "px-5 py-2 bg-emerald-500 hover:bg-emerald-400 text-neutral-950 font-black text-xs rounded-xl transition cursor-pointer shadow-lg shadow-emerald-500/10";
      }
    }
    
    const iconContainer = document.getElementById('confirm-modal-icon-container');
    const icon = document.getElementById('confirm-modal-icon');
    if (iconContainer && icon) {
      if (options.isDanger) {
        iconContainer.className = "p-3 bg-red-500/10 text-red-400 rounded-2xl border border-red-500/20 shrink-0";
        icon.setAttribute('data-lucide', 'alert-triangle');
      } else {
        iconContainer.className = "p-3 bg-emerald-500/10 text-emerald-400 rounded-2xl border border-emerald-500/20 shrink-0";
        icon.setAttribute('data-lucide', 'help-circle');
      }
    }
    
    if (window.lucide) {
      window.lucide.createIcons();
    }
    
    modal.classList.remove('hidden');
    modal.classList.add('flex');
  });
}

function closeCustomConfirm(confirmed) {
  const modal = document.getElementById('custom-confirm-modal');
  if (modal) {
    modal.classList.add('hidden');
    modal.classList.remove('flex');
  }
  if (confirmCallback) {
    confirmCallback(confirmed);
    confirmCallback = null;
  }
}

// Expose all interactive functions explicitly to window scope to ensure HTML onclick events can always invoke them
window.switchView = switchView;
window.initNewSongWizard = initNewSongWizard;
window.dismissDbErrorBanner = dismissDbErrorBanner;
window.resetAllToDefault = resetAllToDefault;
window.toggleWizardAudioSource = toggleWizardAudioSource;
window.initSyncEnginePhase = initSyncEnginePhase;
window.toggleWizardSyncPlayback = toggleWizardSyncPlayback;
window.triggerActiveLineStamp = triggerActiveLineStamp;
window.unstampAllLines = unstampAllLines;
window.switchOffsetWorkspace = switchOffsetWorkspace;
window.saveWorshipTrackToDatabase = saveWorshipTrackToDatabase;
window.stopPerformanceSession = stopPerformanceSession;
window.togglePlayerVocalAssist = togglePlayerVocalAssist;
window.togglePlayerFullscreen = togglePlayerFullscreen;
window.setPlayerTempoSpeed = setPlayerTempoSpeed;
window.goToPrevPlayerLyricRow = goToPrevPlayerLyricRow;
window.togglePerformancePlayback = togglePerformancePlayback;
window.goToNextPlayerLyricRow = goToNextPlayerLyricRow;
window.deleteSongFromDatabase = deleteSongFromDatabase;
window.clearLocalCache = clearLocalCache;
window.loadSongIntoWizard = loadSongIntoWizard;
window.startPerformanceSession = startPerformanceSession;
window.downloadSongToCache = downloadSongToCache;
window.showConfirm = showConfirm;
window.closeCustomConfirm = closeCustomConfirm;
window.setWizardVolume = setWizardVolume;
window.addNewWizardLine = addNewWizardLine;
window.updateWizardItemText = updateWizardItemText;
window.deleteWizardLine = deleteWizardLine;
window.seekWizardTrackTo = seekWizardTrackTo;
window.handleWizardTimelineClick = handleWizardTimelineClick;

function detectDeviceMode() {
  const isMobile = window.innerWidth <= 768;
  if (isMobile) {
    document.documentElement.classList.add('mobile-mode');
    document.documentElement.classList.remove('desktop-mode');
  } else {
    document.documentElement.classList.add('desktop-mode');
    document.documentElement.classList.remove('mobile-mode');
  }
}
window.addEventListener('resize', detectDeviceMode);
detectDeviceMode();

