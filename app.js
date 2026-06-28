// ==========================================
// KeepBuy - 모바일 최적화 장보기 및 냉장고 리스트 로직
// 기능: 로컬/Firebase 실시간 연동, 화면 네비게이션, 텔레그램 연동, 유통기한 알람
// ==========================================

// 1. 상태 및 상수 정의
const SUPABASE_URL = "https://fpfxwvtuucfcybusivxs.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZwZnh3dnR1dWNmY3lidXNpdnhzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI1NDk2NDQsImV4cCI6MjA5ODEyNTY0NH0.fVG8ol57obYy0LluwdsqJup3O-BRTzqI1n3CxD95viQ";
const FAMILY_ID = "default_family"; // 통합 고유 방 키 (모든 기기가 이 키로 자동 연동됨)

let db = {
    shoppingList: [],
    refrigerator: [],
    lastAlertDate: "",
    initialized: true
};

let supabaseClient = null; // Supabase 클라이언트 객체
let supabaseSubscription = null; // 실시간 구독 채널 객체
let isCloudLoaded = false; // 클라우드 데이터 로드 완료 플래그

// 날짜 포맷팅용 헬퍼 함수
function getRelativeDateString(daysOffset) {
    const d = new Date();
    d.setDate(d.getDate() + daysOffset);
    return d.toISOString().split('T')[0];
}

// 초기 데이터 (빈 상태)
const defaultData = {
    shoppingList: [],
    refrigerator: [],
    lastAlertDate: "",
    initialized: true
};

// 2. DOM 요소 선택
const menuBtn = document.getElementById('menuBtn');
const closeDrawerBtn = document.getElementById('closeDrawerBtn');
const menuDrawer = document.getElementById('menuDrawer');
const drawerOverlay = document.getElementById('drawerOverlay');

const syncStatus = document.getElementById('syncStatus');
const statusText = document.getElementById('statusText');
const pageTitle = document.getElementById('pageTitle');

// 탭 네비게이션 요소
const navShoppingBtn = document.getElementById('navShoppingBtn');
const navFridgeBtn = document.getElementById('navFridgeBtn');
const shoppingPage = document.getElementById('shoppingPage');
const fridgePage = document.getElementById('fridgePage');

// 설정 모달 요소
const openSettingsBtn = document.getElementById('openSettingsBtn');
const settingsModal = document.getElementById('settingsModal');
const closeSettingsBtn = document.getElementById('closeSettingsBtn');

// 살 물건 목록 (장보기) 요소
const shoppingForm = document.getElementById('shoppingForm');
const shoppingInput = document.getElementById('shoppingInput');
const shoppingQuantity = document.getElementById('shoppingQuantity');
const shoppingLink = document.getElementById('shoppingLink');
const shoppingListEl = document.getElementById('shoppingList');
const clearCheckedBtn = document.getElementById('clearCheckedBtn');
const sendTelegramBtn = document.getElementById('sendTelegramBtn');

// 살 물건 수정 모달 요소
const editShoppingModal = document.getElementById('editShoppingModal');
const closeEditShoppingBtn = document.getElementById('closeEditShoppingBtn');
const editShoppingForm = document.getElementById('editShoppingForm');
const editShopName = document.getElementById('editShopName');
const editShopQuantity = document.getElementById('editShopQuantity');
const editShopLink = document.getElementById('editShopLink');

let editingShoppingItemId = null;

// 냉장고 물품 수정 모달 요소
const editFridgeModal = document.getElementById('editFridgeModal');
const closeEditFridgeBtn = document.getElementById('closeEditFridgeBtn');
const editFridgeForm = document.getElementById('editFridgeForm');
const editFridgeName = document.getElementById('editFridgeName');
const editFridgeExpiry = document.getElementById('editFridgeExpiry');
const editFridgeQuantity = document.getElementById('editFridgeQuantity');

let editingFridgeItemId = null;

// 나의 냉장고 요소
const fridgeForm = document.getElementById('fridgeForm');
const fridgeInput = document.getElementById('fridgeInput');
const fridgeExpiry = document.getElementById('fridgeExpiry');
const fridgeQuantity = document.getElementById('fridgeQuantity');
const fridgeListEl = document.getElementById('fridgeList');

// 설정 폼 요소
const telegramTokenInput = document.getElementById('telegramTokenInput');
const telegramChatIdInput = document.getElementById('telegramChatIdInput');
const saveTelegramBtn = document.getElementById('saveTelegramBtn');
const disconnectTelegramBtn = document.getElementById('disconnectTelegramBtn');

// 3. 앱 초기화
function initApp() {
    loadData();
    
    // 유통기한 스케줄러 가동 (매 60초마다 시간 확인하여 오전 9시 알람 전송)
    checkExpirationAlarms();
    setInterval(checkExpirationAlarms, 60000);
}

// 4. 데이터 저장/로드 및 동기화 제어 로직
function loadData() {
    isCloudLoaded = false; // 새로운 데이터 로딩 시작 시 완료 플래그 초기화
    
    // 1단계: 로컬 캐시에서 데이터를 즉시 로드하여 렌더링 (블랭크 화면 방지)
    const localDbStr = localStorage.getItem('fridge_db');
    if (localDbStr) {
        try {
            db = JSON.parse(localDbStr);
            if (!db.hasOwnProperty('initialized')) {
                db.initialized = true;
            }
        } catch (e) {
            db = { ...defaultData, initialized: true };
        }
    } else {
        db = { ...defaultData, initialized: true };
        localStorage.setItem('fridge_db', JSON.stringify(db));
    }
    renderShoppingList();
    renderFridgeList();

    // 텔레그램 설정 로드
    const tgToken = localStorage.getItem('fridge_telegram_token') || '';
    const tgChatId = localStorage.getItem('fridge_telegram_chat_id') || '';
    telegramTokenInput.value = tgToken;
    telegramChatIdInput.value = tgChatId;
    
    if (tgToken && tgChatId) {
        disconnectTelegramBtn.style.display = 'block';
    } else {
        disconnectTelegramBtn.style.display = 'none';
    }

    // 기존 Supabase 구독 해제
    if (supabaseSubscription) {
        supabaseSubscription.unsubscribe();
        supabaseSubscription = null;
    }

    updateSyncStatus(true, "Connecting...");
    
    try {
        // Supabase 클라이언트 초기화
        supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
        
        // 1) 최초 데이터 로드
        supabaseClient
            .from('keepbuy_data')
            .select('data')
            .eq('family_id', FAMILY_ID)
            .maybeSingle()
            .then(({ data, error }) => {
                if (error) {
                    console.error("Supabase 로드 실패:", error);
                    updateSyncStatus(false, "Sync Error: " + error.message);
                    return;
                }
                
                isCloudLoaded = true; // 최초 로드 완료 설정
                
                if (data && data.data) {
                    db = {
                        shoppingList: data.data.shoppingList || [],
                        refrigerator: data.data.refrigerator || [],
                        lastAlertDate: data.data.lastAlertDate || "",
                        initialized: data.data.initialized || true
                    };
                    localStorage.setItem('fridge_db', JSON.stringify(db));
                    
                    renderShoppingList();
                    renderFridgeList();
                    updateSyncStatus(true, "Cloud");
                    
                    // 즉시 유통기한 알람 가동 여부 확인
                    checkExpirationAlarms();
                } else {
                    // DB에 데이터가 없으면 로컬 데이터로 초기화 (upsert)
                    persistData();
                    updateSyncStatus(true, "Cloud");
                }
            })
            .catch(err => {
                console.error("Supabase 연결 실패:", err);
                updateSyncStatus(false, "Connection Error: " + err.message);
            });
            
        // 2) 실시간 데이터 변경 구독
        supabaseSubscription = supabaseClient
            .channel('schema-db-changes')
            .on(
                'postgres_changes',
                {
                    event: '*',
                    schema: 'public',
                    table: 'keepbuy_data',
                    filter: `family_id=eq.${FAMILY_ID}`
                },
                (payload) => {
                    console.log('실시간 데이터 변화 수신:', payload);
                    if (payload.new && payload.new.data) {
                        db = {
                            shoppingList: payload.new.data.shoppingList || [],
                            refrigerator: payload.new.data.refrigerator || [],
                            lastAlertDate: payload.new.data.lastAlertDate || "",
                            initialized: payload.new.data.initialized || true
                        };
                        localStorage.setItem('fridge_db', JSON.stringify(db));
                        renderShoppingList();
                        renderFridgeList();
                        checkExpirationAlarms();
                    }
                }
            )
            .subscribe();
            
    } catch (e) {
        console.error("Supabase 초기화 에러:", e);
        updateSyncStatus(false, "URL Error");
    }
}

function loadLocalFallback() {
    console.log("로컬 캐시 백업 모드 실행 중");
}

function updateSyncStatus(isCloud, text) {
    syncStatus.className = 'status-indicator';
    if (isCloud) {
        if (text === "Connecting...") {
            syncStatus.classList.add('local');
            statusText.textContent = "Connecting...";
        } else {
            syncStatus.classList.add('syncing');
            statusText.textContent = "Cloud Active";
        }
    } else {
        syncStatus.classList.add('local');
        statusText.textContent = text || "Local Mode";
    }
}

function persistData() {
    // 1단계: 로컬 캐시에 즉시 저장
    localStorage.setItem('fridge_db', JSON.stringify(db));
    
    // 로컬 모드 혹은 최초 클라우드 로드 완료 전에는 즉각적인 화면 렌더링만 수행하고 업로드 보류
    if (!supabaseClient || !isCloudLoaded) {
        renderShoppingList();
        renderFridgeList();
        console.log("Supabase 미연동 혹은 초기 데이터 로드 중 - 클라우드 업로드 보류");
        return;
    }
    
    // 2단계: Supabase 비동기 클라우드 동기화 (upsert)
    supabaseClient
        .from('keepbuy_data')
        .upsert({
            family_id: FAMILY_ID,
            data: db,
            updated_at: new Date().toISOString()
        })
        .then(({ error }) => {
            if (error) {
                console.error("Supabase 동기화 실패:", error);
            } else {
                console.log("Supabase 동기화 완료");
            }
        })
        .catch(err => {
            console.error("Supabase 전송 에러:", err);
        });
}

// 텔레그램 알림 발송 공통 함수
function sendTelegramAlert(message) {
    const token = localStorage.getItem('fridge_telegram_token');
    const chatId = localStorage.getItem('fridge_telegram_chat_id');
    if (!token || !chatId) return Promise.reject("설정되지 않음");
    
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    return fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            chat_id: chatId,
            text: message,
            parse_mode: 'HTML'
        })
    })
    .then(res => {
        if (!res.ok) throw new Error('Telegram API status: ' + res.status);
        console.log('Telegram 알림 발송 성공');
    });
}

// 5. 날짜 및 유통기한 계산 헬퍼 로직
function getKSTTime() {
    // 다차원 시간대 대응을 위해 강제로 한국(Asia/Seoul) 표준시간 계산
    const kstDate = new Date(new Date().toLocaleString("en-US", {timeZone: "Asia/Seoul"}));
    const year = kstDate.getFullYear();
    const month = String(kstDate.getMonth() + 1).padStart(2, '0');
    const date = String(kstDate.getDate()).padStart(2, '0');
    const hours = kstDate.getHours();
    const minutes = kstDate.getMinutes();
    return {
        dateStr: `${year}-${month}-${date}`,
        hours,
        minutes
    };
}

function calculateDDay(expiryDateStr) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const expiry = new Date(expiryDateStr);
    expiry.setHours(0, 0, 0, 0);
    
    const diffTime = expiry - today;
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    
    return diffDays;
}

function getDDayLabel(diffDays) {
    if (diffDays < 0) {
        return `만료 D+${Math.abs(diffDays)}`;
    } else if (diffDays === 0) {
        return '오늘 만료';
    } else {
        return `D-${diffDays}`;
    }
}

function getItemStatus(diffDays) {
    if (diffDays < 0) return 'expired';
    if (diffDays <= 3) return 'warning';
    return 'safe';
}

// 6. 아침 9시 하이브리드 유통기한 자동 알림 엔진
function checkExpirationAlarms() {
    const kst = getKSTTime();
    
    // 한국 시간 기준 오전 9시가 지났는지 체크
    if (kst.hours >= 9) {
        // 오늘 날짜로 이미 경고 알림을 보냈는지 확인 (중복 발송 제한)
        if (db.lastAlertDate !== kst.dateStr) {
            
            const expiredItems = [];
            const todayItems = [];
            const warningItems = []; // 3일 이내 임박
            
            if (db.refrigerator && db.refrigerator.length > 0) {
                db.refrigerator.forEach(item => {
                    const diffDays = calculateDDay(item.expiryDate);
                    if (diffDays < 0) {
                        expiredItems.push({ ...item, diffDays: Math.abs(diffDays) });
                    } else if (diffDays === 0) {
                        todayItems.push(item);
                    } else if (diffDays > 0 && diffDays <= 3) {
                        warningItems.push({ ...item, diffDays });
                    }
                });
            }
            
            // 경고할 품목이 하나라도 있는 경우 알림 발송
            if (expiredItems.length > 0 || todayItems.length > 0 || warningItems.length > 0) {
                let msg = `⚠️ <b>[냉장고 유통기한 경고 알림]</b>\n소비가 시급한 냉장고 품목이 존재합니다. 확인해 주세요!\n`;
                
                if (expiredItems.length > 0) {
                    msg += `\n🚨 <b>유통기한 만료 (버려주세요!):</b>\n`;
                    expiredItems.forEach(item => {
                        msg += `- ${item.name} (${item.quantity || '수량 미지정'}) : ${item.expiryDate} 만료 (${item.diffDays}일 지남)\n`;
                    });
                }
                
                if (todayItems.length > 0) {
                    msg += `\n⏰ <b>오늘 만료 (오늘 드셔야 해요!):</b>\n`;
                    todayItems.forEach(item => {
                        msg += `- ${item.name} (${item.quantity || '수량 미지정'}) : 오늘 유통기한 도달\n`;
                    });
                }
                
                if (warningItems.length > 0) {
                    msg += `\n🥦 <b>유통기한 임박 (3일 이내):</b>\n`;
                    warningItems.forEach(item => {
                        msg += `- ${item.name} (${item.quantity || '수량 미지정'}) : ${item.expiryDate} 만료 (D-${item.diffDays})\n`;
                    });
                }
                
                // 텔레그램 발송 요청
                sendTelegramAlert(msg)
                    .then(() => {
                        // 발송 완료 표시를 기록하고 Firebase/로컬 저장
                        db.lastAlertDate = kst.dateStr;
                        persistData();
                        console.log("9시 유통기한 알림 발송 완료");
                    })
                    .catch(err => {
                        console.error("텔레그램 알림 발송 대기 중:", err);
                    });
            } else {
                // 알림 보낼 물건이 없더라도 오늘 체크가 끝났음을 표시
                db.lastAlertDate = kst.dateStr;
                persistData();
                console.log("오늘 보낼 알림 대상 품목이 없습니다.");
            }
        }
    }
}

// 7. UI 렌더링 로직 (살 물건 목록 & 나의 냉장고)
function renderShoppingList() {
    shoppingListEl.innerHTML = '';
    
    if (!db.shoppingList || db.shoppingList.length === 0) {
        shoppingListEl.innerHTML = '<li class="empty-state-text">장볼 물건이 없습니다. 상단에서 물건을 추가해 보세요!</li>';
        clearCheckedBtn.style.display = 'none';
        return;
    }

    let hasChecked = false;

    // 미완료 우선, 최신순 정렬
    const sortedList = [...db.shoppingList].sort((a, b) => {
        if (a.checked !== b.checked) {
            return a.checked ? 1 : -1;
        }
        return b.id.localeCompare(a.id);
    });

    sortedList.forEach((item) => {
        if (item.checked) hasChecked = true;

        const li = document.createElement('li');
        li.className = `shopping-item ${item.checked ? 'checked' : ''}`;
        li.dataset.id = item.id;
        
        const qtyHtml = item.quantity ? `<span class="shopping-item-quantity">${escapeHTML(item.quantity)}</span>` : '';
        
        const linkHtml = item.link ? `
            <a href="${escapeHTML(item.link)}" target="_blank" rel="noopener noreferrer" class="shopping-item-link-btn">
                구매
                <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="inline-icon"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>
            </a>
        ` : '';

        // 수정 연필 버튼 HTML
        const editBtnHtml = `
            <button class="edit-item-btn" aria-label="수정">
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="inline-icon"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path></svg>
            </button>
        `;
        
        li.innerHTML = `
            <div class="shopping-item-left">
                <div class="custom-checkbox">
                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
                </div>
                <span class="shopping-item-name">${escapeHTML(item.name)}</span>
                ${qtyHtml}
            </div>
            ${linkHtml}
            ${editBtnHtml}
            <button class="delete-item-btn" aria-label="삭제">
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
            </button>
        `;

        // 리스트 클릭 시 토글
        li.addEventListener('click', () => toggleShoppingItem(item.id));
        
        // 구매 링크 클릭 시 이벤트 버블링 방지
        const linkBtn = li.querySelector('.shopping-item-link-btn');
        if (linkBtn) {
            linkBtn.addEventListener('click', (e) => e.stopPropagation());
        }

        // 수정 버튼 클릭
        const editBtn = li.querySelector('.edit-item-btn');
        editBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            openEditShoppingModal(item.id);
        });

        // 삭제 버튼 클릭
        const deleteBtn = li.querySelector('.delete-item-btn');
        deleteBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            deleteShoppingItem(item.id);
        });

        shoppingListEl.appendChild(li);
    });

    clearCheckedBtn.style.display = hasChecked ? 'block' : 'none';
}

function renderFridgeList() {
    fridgeListEl.innerHTML = '';
    
    if (!db.refrigerator || db.refrigerator.length === 0) {
        fridgeListEl.innerHTML = '<li class="empty-state-text">냉장고에 들어있는 품목이 없습니다. 상단에서 보관할 물품을 등록하세요!</li>';
        return;
    }

    // 디데이 오름차순 정렬 (위험도가 급할수록 최상단 정렬)
    const sortedList = [...db.refrigerator].sort((a, b) => {
        return calculateDDay(a.expiryDate) - calculateDDay(b.expiryDate);
    });

    sortedList.forEach((item) => {
        const diffDays = calculateDDay(item.expiryDate);
        const status = getItemStatus(diffDays);
        const ddayLabel = getDDayLabel(diffDays);
        
        const li = document.createElement('li');
        li.className = 'shopping-item'; // 목록 구조를 위해 스타일 재사용
        li.dataset.id = item.id;
        
        const qtyHtml = item.quantity ? `<span class="shopping-item-quantity" style="margin-left: 0;">${escapeHTML(item.quantity)}</span>` : '';
        const expiryHtml = `<span class="fridge-item-expiry status-${status}" style="margin-left: 0;">${ddayLabel}</span>`;
        
        // 장보기 리스트로 자동 이관하는 [+장보기] 재구매 버튼 HTML
        const reorderBtnHtml = `
            <button class="reorder-btn" title="재구매 및 장보기 추가">
                +장보기
            </button>
        `;

        // 수정 연필 버튼 HTML
        const editBtnHtml = `
            <button class="edit-item-btn" aria-label="수정">
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="inline-icon"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path></svg>
            </button>
        `;
        
        li.innerHTML = `
            <div class="shopping-item-left" style="flex-direction: column; align-items: flex-start; gap: 4px; padding-left: 4px;">
                <span class="shopping-item-name" style="margin-left: 0; text-align: left;">${escapeHTML(item.name)}</span>
                <div class="fridge-item-sub-info" style="display: flex; align-items: center; gap: 6px;">
                    ${qtyHtml}
                    ${expiryHtml}
                </div>
            </div>
            ${reorderBtnHtml}
            ${editBtnHtml}
            <button class="delete-item-btn" aria-label="삭제">
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
            </button>
        `;

        // +장보기 버튼 클릭
        const reorderBtn = li.querySelector('.reorder-btn');
        reorderBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            reorderFridgeItem(item.id);
        });

        // 수정 버튼 클릭
        const editBtn = li.querySelector('.edit-item-btn');
        editBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            openEditFridgeModal(item.id);
        });

        // 삭제 버튼 클릭
        const deleteBtn = li.querySelector('.delete-item-btn');
        deleteBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            deleteFridgeItem(item.id);
        });

        fridgeListEl.appendChild(li);
    });
}

function escapeHTML(str) {
    if (!str) return '';
    return str.replace(/[&<>'"]/g, 
        tag => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            "'": '&#39;',
            '"': '&quot;'
        }[tag] || tag)
    );
}

// 8. 인터랙션 및 설정 제어
menuBtn.addEventListener('click', () => {
    menuDrawer.classList.add('active');
    drawerOverlay.classList.add('active');
});

function closeDrawer() {
    menuDrawer.classList.remove('active');
    drawerOverlay.classList.remove('active');
}

closeDrawerBtn.addEventListener('click', closeDrawer);
drawerOverlay.addEventListener('click', closeDrawer);

// 설정 모달 열기/닫기
openSettingsBtn.addEventListener('click', () => {
    settingsModal.classList.add('active');
    closeDrawer();
});

closeSettingsBtn.addEventListener('click', () => {
    settingsModal.classList.remove('active');
});

settingsModal.addEventListener('click', (e) => {
    if (e.target === settingsModal) {
        settingsModal.classList.remove('active');
    }
});

// SPA 탭 네비게이션 제어
navShoppingBtn.addEventListener('click', () => switchTab('shopping'));
navFridgeBtn.addEventListener('click', () => switchTab('fridge'));

function switchTab(tab) {
    if (tab === 'shopping') {
        shoppingPage.classList.add('active');
        fridgePage.classList.remove('active');
        navShoppingBtn.classList.add('active');
        navFridgeBtn.classList.remove('active');
        pageTitle.innerHTML = 'Keep<span class="accent-text">Buy</span>';
    } else {
        shoppingPage.classList.remove('active');
        fridgePage.classList.add('active');
        navShoppingBtn.classList.remove('active');
        navFridgeBtn.classList.add('active');
        pageTitle.innerHTML = 'My<span class="accent-text">Fridge</span>';
    }
    closeDrawer();
}

// 9. 살 물건 목록 (장보기) CRUD 로직
shoppingForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = shoppingInput.value.trim();
    const quantity = shoppingQuantity.value.trim();
    const link = shoppingLink.value.trim();
    
    if (!name) return;

    const newItem = {
        id: 'shop-' + Date.now(),
        name,
        quantity,
        link,
        checked: false
    };

    if (!db.shoppingList) db.shoppingList = [];
    db.shoppingList.push(newItem);
    
    shoppingInput.value = '';
    shoppingQuantity.value = '';
    shoppingLink.value = '';
    
    persistData();
});

function toggleShoppingItem(id) {
    db.shoppingList = db.shoppingList.map(item => {
        if (item.id === id) {
            return { ...item, checked: !item.checked };
        }
        return item;
    });
    persistData();
}

window.deleteShoppingItem = function(id) {
    db.shoppingList = db.shoppingList.filter(item => item.id !== id);
    persistData();
};

clearCheckedBtn.addEventListener('click', () => {
    db.shoppingList = db.shoppingList.filter(item => !item.checked);
    persistData();
});

// 수동 텔레그램 전송 로직 (추가 시 발송하는 기존 방식 기각)
sendTelegramBtn.addEventListener('click', () => {
    const unchecked = db.shoppingList.filter(item => !item.checked);
    if (unchecked.length === 0) {
        alert('구매하셔야 할 살 물건 품목이 없습니다!');
        return;
    }
    
    let msg = `🛒 <b>[KeepBuy 장보기 목록]</b>\n현재 구매 예정인 목록 전체를 공유합니다.\n\n`;
    unchecked.forEach((item, index) => {
        msg += `${index + 1}. <b>${item.name}</b>`;
        if (item.quantity) msg += ` (${item.quantity})`;
        if (item.link) msg += ` - <a href="${item.link}">구매하기</a>`;
        msg += `\n`;
    });
    msg += `\n총 ${unchecked.length}개의 품목이 리스트에 올라와 있습니다.`;
    
    sendTelegramBtn.disabled = true;
    sendTelegramAlert(msg)
        .then(() => {
            alert('텔레그램 단톡방으로 장보기 목록 전송이 완료되었습니다!');
        })
        .catch((err) => {
            alert('알림 발송에 실패했습니다. 텔레그램 연동 설정을 확인해 주세요.');
            console.error(err);
        })
        .finally(() => {
            sendTelegramBtn.disabled = false;
        });
});

// 살 물건 정보 수정 모달 제어 로직
window.openEditShoppingModal = function(id) {
    const item = db.shoppingList.find(item => item.id === id);
    if (item) {
        editingShoppingItemId = id;
        editShopName.value = item.name;
        editShopQuantity.value = item.quantity || '';
        editShopLink.value = item.link || '';
        editShoppingModal.classList.add('active');
    }
};

closeEditShoppingBtn.addEventListener('click', () => {
    editShoppingModal.classList.remove('active');
    editingShoppingItemId = null;
});

editShoppingModal.addEventListener('click', (e) => {
    if (e.target === editShoppingModal) {
        editShoppingModal.classList.remove('active');
        editingShoppingItemId = null;
    }
});

editShoppingForm.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!editingShoppingItemId) return;
    
    const name = editShopName.value.trim();
    const quantity = editShopQuantity.value.trim();
    const link = editShopLink.value.trim();
    
    if (!name) return;
    
    db.shoppingList = db.shoppingList.map(item => {
        if (item.id === editingShoppingItemId) {
            return {
                ...item,
                name,
                quantity,
                link
            };
        }
        return item;
    });
    
    editShoppingModal.classList.remove('active');
    editingShoppingItemId = null;
    
    persistData();
});

// 10. 나의 냉장고 CRUD 로직
fridgeForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = fridgeInput.value.trim();
    const expiry = fridgeExpiry.value;
    const quantity = fridgeQuantity.value.trim();
    
    if (!name || !expiry) return;

    const newItem = {
        id: 'fridge-' + Date.now(),
        name,
        expiryDate: expiry,
        quantity
    };

    if (!db.refrigerator) db.refrigerator = [];
    db.refrigerator.push(newItem);
    
    fridgeInput.value = '';
    fridgeExpiry.value = '';
    fridgeQuantity.value = '';
    
    persistData();
});

window.deleteFridgeItem = function(id) {
    db.refrigerator = db.refrigerator.filter(item => item.id !== id);
    persistData();
};

window.reorderFridgeItem = function(id) {
    const itemIndex = db.refrigerator.findIndex(item => item.id === id);
    if (itemIndex > -1) {
        const item = db.refrigerator[itemIndex];
        
        // 장보기 목록에 추가
        const newItem = {
            id: 'shop-' + Date.now(),
            name: item.name,
            quantity: item.quantity || '',
            link: '', // 냉장고의 품목은 구매 링크가 기본적으로 없으므로 공란 설정
            checked: false
        };
        
        if (!db.shoppingList) db.shoppingList = [];
        db.shoppingList.push(newItem);
        
        // 냉장고에서 삭제
        db.refrigerator.splice(itemIndex, 1);
        
        persistData();
    }
};

// 냉장고 물품 정보 수정 모달 제어 로직
window.openEditFridgeModal = function(id) {
    const item = db.refrigerator.find(item => item.id === id);
    if (item) {
        editingFridgeItemId = id;
        editFridgeName.value = item.name;
        editFridgeExpiry.value = item.expiryDate;
        editFridgeQuantity.value = item.quantity || '';
        editFridgeModal.classList.add('active');
    }
};

closeEditFridgeBtn.addEventListener('click', () => {
    editFridgeModal.classList.remove('active');
    editingFridgeItemId = null;
});

editFridgeModal.addEventListener('click', (e) => {
    if (e.target === editFridgeModal) {
        editFridgeModal.classList.remove('active');
        editingFridgeItemId = null;
    }
});

editFridgeForm.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!editingFridgeItemId) return;
    
    const name = editFridgeName.value.trim();
    const expiry = editFridgeExpiry.value;
    const quantity = editFridgeQuantity.value.trim();
    
    if (!name || !expiry) return;
    
    db.refrigerator = db.refrigerator.map(item => {
        if (item.id === editingFridgeItemId) {
            return {
                ...item,
                name,
                expiryDate: expiry,
                quantity
            };
        }
        return item;
    });
    
    editFridgeModal.classList.remove('active');
    editingFridgeItemId = null;
    
    persistData();
});


// 11. 텔레그램 알림 설정 제어 로직
saveTelegramBtn.addEventListener('click', () => {
    const token = telegramTokenInput.value.trim();
    const chatId = telegramChatIdInput.value.trim();
    if (token && chatId) {
        localStorage.setItem('fridge_telegram_token', token);
        localStorage.setItem('fridge_telegram_chat_id', chatId);
        alert('텔레그램 알림 설정이 저장되었습니다. 단톡방으로 테스트 메시지를 전송합니다.');
        sendTelegramAlert('🔔 <b>[연동 완료]</b> 스마트 장보기 리스트 알림 연동이 성공적으로 완료되었습니다.');
    } else {
        localStorage.removeItem('fridge_telegram_token');
        localStorage.removeItem('fridge_telegram_chat_id');
    }
    settingsModal.classList.remove('active');
    loadData();
});

disconnectTelegramBtn.addEventListener('click', () => {
    localStorage.removeItem('fridge_telegram_token');
    localStorage.removeItem('fridge_telegram_chat_id');
    telegramTokenInput.value = '';
    telegramChatIdInput.value = '';
    alert('텔레그램 알림 연동이 해제되었습니다.');
    settingsModal.classList.remove('active');
    loadData();
});

// 앱 기동!
window.onload = initApp;
