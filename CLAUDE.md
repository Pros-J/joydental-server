# 조이치과 관리 시스템 — 개발 컨텍스트

## 프로젝트 구조
- **메인 파일**: `public/조이치과 관리 시스템.html` — 단일 HTML 파일 앱 (vanilla JS, no framework)
- **백엔드**: `index.js` — Express + PostgreSQL (Railway 배포)
- **수정 후 배포 순서**:
  1. 로컬: `C:\Users\Dr.Jeong\Desktop\치과지출관리 프로그램 제작\조이치과 관리 시스템.html` 편집
  2. `server\public\` 에 복사
  3. `server\` 에서 git push → Railway 자동 배포

## 기술 스택
- 프론트: 단일 HTML 파일, DB 객체(`DB._cache`)로 in-memory + localStorage + PostgreSQL 동기화
- 인증: JWT (`Auth.isAdmin()` / `Auth.isStaff()`)
- 배포: Railway (PostgreSQL 포함), GitHub 레포: `Pros-J/joydental-server`

## 주요 데이터 구조

### 일반 치과재료 주문 (generalOrders)
```javascript
{
  id, order_group_id,   // 주문서 그룹 (없으면 구형 단건 레코드)
  date, vendor, status, // 주문서 상태: '주문서 작성' | '주문서 발행 완료'
  memo, item_status,    // 품목 상태: '' | '입고확인' | '반품 신청' | '반품완료'
  description, quantity, unit_price, total_amount, note
}
```
- `order_group_id` 없는 구형 레코드는 `status` 필드가 품목 상태('주문'/'입고확인'/'반품')
- 온라인 주문 거래처(`vendor.online_order=true`)는 저장 시 자동 '주문서 발행 완료'

### 임플란트 재료 주문 (implantOrders)
```javascript
{
  id, order_group_id, date, vendor, status, memo,
  item_status,   // '' | '입고확인' | '반품 신청' | '반품완료'
  item_type,     // 'fixture' | 'mat'
  item_id, item_name, quantity, unit_price, total
}
```

### 거래처 (vendors)
```javascript
{ id, category, name, online_order, manager, phone, note }
// category: '임플란트' | '일반재료' | '기공소' | '기타'
// online_order: true면 담당자/연락처 없음, SMS 발송 안 함, 주문 즉시 발행 완료
```

### 픽스쳐 (fixtures)
```javascript
{ id, company, fixture_type, diameter, length, unit_price, stock, min_stock, vendor }
```

### 임플란트 재료 (implantMaterials)
```javascript
{ id, category, name, spec, unit_price, stock, min_stock, vendor }
```

## 주요 함수 위치 (HTML 파일)
- `dashboard()` — 대시보드, `totalImplantOrder` / `totalImplantUsage` 분리
- `general(y, m)` — 일반 치과재료 주문 목록 (주문서 그룹 방식)
- `setOrderStatus(groupId, newStatus)` — 임플란트 주문서 상태 변경 + SMS 발송
- `publishGeneralGroup(gid)` — 일반재료 주문서 발행 + SMS 발송
- `saveGeneralGroup(e, editKey)` — 일반재료 주문서 저장
- `_implantOrders(y, m)` — 임플란트 주문 목록
- `setItemStatus(itemId, newItemStatus)` — 임플란트 품목별 상태 + 재고 조정
- `_implantReturns(y, m)` — 픽스쳐 페일/반품 목록

## SMS 연동 (CoolSMS/Solapi)
- 환경변수: `COOLSMS_API_KEY`, `COOLSMS_API_SECRET`, `COOLSMS_SENDER`
- 서버 엔드포인트: `POST /api/sms` — `{ to, text }` 받아서 LMS 발송
- 발송 시점: 주문서 발행 완료 시 거래처 `phone` 번호로 자동 발송
- 온라인 거래처는 SMS 발송하지 않음 (전화번호 없음)
- 항상 `type: 'LMS'` 고정 (한글 포함으로 90바이트 초과)

## 계산 규칙
- `totalImplantOrder`: 반품완료 품목(`item_status !== '반품완료'`) 제외한 주문액
- `totalImplantUsage`: 사용기록 기준 (픽스쳐 페일 반품완료 제외)
- `totalGeneral`: 반품완료 품목 제외 (구형: `status !== '반품'`)
- 대시보드 grandTotal = 직접지출 + 임플란트주문액 + 일반재료 + 기공의뢰

## 주의사항
- `dashboard()` 함수 내 `const fixtures` (재고 알림용)와 `const allFixtures` (가격 조회용) 변수명 충돌 주의
- `getSettings()` 반환값에 `labs`, `directCategories` 등 null 체크 필수 (`||[]` 방어코드)
- HTML 파일 편집 후 반드시 `server\public\`에 복사 후 push
