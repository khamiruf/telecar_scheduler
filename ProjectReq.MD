# Project Specification: Shared Car Scheduling & Tracker (Telegram Mini App) v2.0

## 1. Executive Summary

**Goal:** Build a Minimum Viable Product (MVP) for a shared car system.
**Platform:** Telegram Mini App (Web App launched inside Telegram).
**Core Value:** A friction-free, mobile-first interface allowing a closed group of users to:

1. View/Book/Cancel car reservations.
2. Check and update the specific floor/level where the car is currently parked.
3. Ensure privacy via a "whitelist" access control system.

---

## 2. Technical Architecture

* **Platform:** Telegram Web App (TWA).
* **Frontend:** React (Vite) + TypeScript.
* **UI Framework:** Shadcn/UI or Material UI (Mobile optimized).
* **Database & Sync:** Firebase Realtime Database.
* **Authentication:** Implicit Auth via `window.Telegram.WebApp.initDataUnsafe` + **Frontend Whitelist Validation**.
* **Hosting:** Vercel (Frontend).

---

## 3. User Stories & Acceptance Criteria

### Story 0: Access Control (The "Frontend Bouncer")

**As a** generic Telegram user,
**I want the app to** verify my identity immediately upon opening,
**So that** random strangers cannot access our car schedule or location.

* **Acceptance Criteria:**
* [ ] On app load, system captures the `user_id` from Telegram.
* [ ] System checks this `user_id` against a hardcoded list or database list of `allowed_users`.
* [ ] **If Authorized:** The main app (Calendar/Location) loads.
* [ ] **If Unauthorized:** A "403 Access Denied" screen is shown with no interactive elements.



### Story 1: View Schedule & Location

**As an** authorized user,
**I want to** see the weekly calendar and the car's current parking level,
**So that** I know if the car is free and exactly where to find it.

* **Acceptance Criteria:**
* [ ] App displays a "Status Card" at the top: *"Car is at: Level 4A"*.
* [ ] Below the card, time slots are displayed in 1-hour increments.
* [ ] Booked slots are visually distinct (e.g., Greyed out) and show the user's name.



### Story 2: Update Car Location

**As an** authorized user,
**I want to** easily update the parking level when I return the car,
**So that** the next user doesn't have to hunt for it.

* **Acceptance Criteria:**
* [ ] A prominent "Update Location" button (or editable field) is visible near the top status card.
* [ ] User enters the new level (e.g., "5B", "B1") and taps Save.
* [ ] The update is instantly reflected for all other users.
* [ ] **No History Needed:** Only the current value is stored. Overwriting is allowed.



### Story 3: Make a Reservation

**As an** authorized user,
**I want to** tap on an available time slot,
**So that** I can reserve the car for myself.

* **Acceptance Criteria:**
* [ ] Tapping a "Free" slot prompts a confirmation.
* [ ] User confirms via the Telegram Native "Main Button".
* [ ] System records: `user_id`, `first_name`, and `timestamp`.
* [ ] **Constraint:** Cannot book overlapping slots.



### Story 4: Cancel Reservation

**As an** authorized user,
**I want to** tap on a slot I previously booked,
**So that** I can release the car if I no longer need it.

* **Acceptance Criteria:**
* [ ] Tapping a slot booked by *Current User* shows "Cancel Booking".
* [ ] Tapping a slot booked by *Someone Else* shows read-only details.
* [ ] User cannot delete others' bookings.



---

## 4. Data Model (Firebase Realtime DB)

The database consists of three main nodes: `allowed_users` (for the bouncer), `current_location` (for the tracker), and `bookings` (for the schedule).

```json
{
  "allowed_users": {
    "12345678": "Khairul",
    "87654321": "German Friend"
  },
  "car_status": {
    "current_level": "Level 4A",
    "updated_by": "Khairul",
    "updated_at": 1734685000
  },
  "bookings": {
    "2025-12-25": {
      "09-00": {
        "userId": 12345678,
        "userName": "Khairul"
      },
      "14-00": {
        "userId": 87654321,
        "userName": "German Friend"
      }
    }
  }
}

```

---

## 5. UI/UX Guidelines

### Layout Structure

1. **Header (Sticky):**
* Title: "Shared Car"
* **Location Badge:** Large text "📍 Level 4A" (Tapping this opens an edit prompt).


2. **Body (Scrollable):**
* Calendar Grid (Week View).


3. **Footer (Fixed):**
* Telegram Native Main Button (Hidden by default, appears when a slot is selected).



### "Native" Behavior

* **Haptic Feedback:** Trigger `impactOccurred('light')` when changing the car location.
* **Theme Matching:** Ensure the "Access Denied" screen matches the user's Telegram theme (Dark/Light) so it doesn't look like a generic web error.

---

## 6. Development Roadmap (Updated)

1. **Phase 1: Security First**
* Initialize React.
* Implement `useEffect` hook to capture Telegram `user_id`.
* Build the "Bouncer" logic: Fetch `/allowed_users` -> Check ID -> Render App or Error.


2. **Phase 2: Location Tracker**
* Build the Top Status Card.
* Connect input field to Firebase path `/car_status/current_level`.
* Implement real-time listener so the text changes instantly when someone else edits it.


3. **Phase 3: The Calendar**
* Build the grid for the current week.
* Fetch booking data and render.


4. **Phase 4: Booking Logic**
* Implement booking/cancellation write operations.
* Add conflicting booking checks.