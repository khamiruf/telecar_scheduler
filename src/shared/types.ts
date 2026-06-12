// Types shared between the Worker API and the Mini App.

export interface CarStatus {
  level: string;
  updatedBy: string;
  updatedAt: number; // unix seconds
}

export interface Booking {
  id: number;
  userId: number;
  userName: string;
  startsAt: number; // unix seconds
  endsAt: number; // unix seconds
}

export interface Me {
  id: number;
  firstName: string;
  isAdmin: boolean;
}

export interface ApiError {
  error: string;
}
