# Implementation Plan: Shared Car Scheduling & Tracker

This plan outlines the steps to build the Shared Car Telegram Mini App based on `GEMINI.MD`.

## 0. Project Initialization & Setup
- [ ] **Dependencies**: Install necessary packages.
    - `firebase`: For Realtime Database.
    - `@twa-dev/sdk` or `@types/telegram-web-app`: For Telegram Web App integration.
    - UI Framework: `shadcn/ui` (requires `tailwindcss`) or `MUI`. *Decision: We will use Tailwind CSS + Shadcn/UI for a lightweight, mobile-first look.*
    - `date-fns`: For easy date manipulation.
- [ ] **Configuration**:
    - Initialize Tailwind CSS.
    - Set up Firebase project configuration (firebase.ts).
    - Configure global types for Telegram Web App.

## 1. Phase 1: Security First (The Bouncer)
- [ ] **Telegram SDK Init**: Initialize `window.Telegram.WebApp` on app mount.
- [ ] **User Context**: Create a React Context/Hook (`useTelegramUser`) to manage the current user's state.
- [ ] **Whitelist System**:
    - Implement a service to check `user_id` against a hardcoded list (MVP step 1) or Firebase `allowed_users` node.
- [ ] **Access Control Views**:
    - Create a `<Bouncer>` wrapper component.
    - Implement `<AccessDenied />` screen (matches Telegram theme).
    - Implement `<Loading />` screen while checking permissions.

## 2. Phase 2: Location Tracker
- [ ] **Data Service**: Create `services/carStatus.ts` to read/write to `car_status` node in Firebase.
- [ ] **UI Component**: Create `<LocationCard />`.
    - Display current level.
    - "Edit" button to toggle edit mode.
    - Input field for new level.
    - Save button to write to Firebase.
- [ ] **Realtime Sync**: Ensure the component subscribes to Firebase changes so updates are reflected instantly.

## 3. Phase 3: The Calendar (Schedule View)
- [ ] **Data Model**: Define interfaces for `Booking`.
- [ ] **Calendar Logic**:
    - Generate time slots for the current week/day (00:00 - 23:00).
    - Helper functions to format dates/times.
- [ ] **UI Component**: Create `<ScheduleGrid />`.
    - Display days/time slots.
    - Fetch bookings from `bookings` node in Firebase.
    - Render booked slots visually distinct (Greyed out + User Name).

## 4. Phase 4: Booking Logic
- [ ] **Interaction**:
    - Tap "Free" slot -> Select slot.
    - Tap "Booked" slot (by self) -> Select slot.
    - Tap "Booked" slot (by others) -> Show info (Read-only).
- [ ] **Telegram Main Button**:
    - Show "Book Slot" or "Cancel Booking" on the Telegram Main Button when a slot is selected.
    - Handle Main Button click events.
- [ ] **Firebase Writes**:
    - Implement `bookSlot(date, time, user)` function.
    - Implement `cancelSlot(date, time)` function.
    - Validation: Check if slot is still free before writing (prevent race conditions).

## 5. UI/UX Polish
- [ ] **Haptic Feedback**: Use `Telegram.WebApp.HapticFeedback` for actions (booking, changing location).
- [ ] **Theming**: Ensure CSS variables adapt to `Telegram.WebApp.colorScheme`.
- [ ] **Responsive Design**: Verify mobile layout (padding, font sizes).

## 6. Testing & Deployment
- [ ] **Manual Testing**: Test with mock Telegram user data.
- [ ] **Build**: Run `npm run build`.
- [ ] **Deployment**: Prepare for Vercel deployment (optional for this CLI session, but good to have ready).
