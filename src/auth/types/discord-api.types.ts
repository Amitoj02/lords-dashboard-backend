/** Shapes returned by the Discord OAuth2 + REST API (only the fields we use). */

export interface DiscordTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
  scope: string;
}

export interface DiscordUser {
  id: string;
  username: string;
  global_name?: string | null;
  discriminator?: string;
  avatar?: string | null;
  email?: string | null;
  verified?: boolean;
}
