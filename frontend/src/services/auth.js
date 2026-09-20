const AUTH_STORAGE_KEY = "nexus.demo.auth";

const INVESTIGATOR_USERNAMES = [
  "Officer001",
  "Officer002",
  "Officer003",
  "Officer004",
  "Officer005",
  "Officer006",
  "Officer007",
  "Officer008",
  "Officer009",
];
const SENIOR_USERNAMES = [
  "Senior001",
  "Senior002",
  "Senior003",
  "Senior004",
  "Senior005",
  "Senior006",
  "Senior007",
  "Senior008",
  "Senior009",
];
const DEMO_INVESTIGATOR_PASSWORD = "890890";
const DEMO_SENIOR_PASSWORD = "123123";

export async function loginWithDemoCredentials(username, password) {
  const trimmedUsername = username.trim();

  if (SENIOR_USERNAMES.includes(trimmedUsername)) {
    if (password !== DEMO_SENIOR_PASSWORD) {
      throw new Error("Invalid username or password.");
    }

    return {
      id: trimmedUsername,
      name: trimmedUsername,
      username: trimmedUsername,
      role: "senior",
    };
  }

  if (INVESTIGATOR_USERNAMES.includes(trimmedUsername)) {
    if (password !== DEMO_INVESTIGATOR_PASSWORD) {
      throw new Error("Invalid username or password.");
    }

    return {
      id: trimmedUsername,
      name: trimmedUsername,
      username: trimmedUsername,
      role: "investigator",
    };
  }

  throw new Error("Invalid username or password.");
}

export function getStoredUser() {
  try {
    const storedUser = window.localStorage.getItem(AUTH_STORAGE_KEY);
    if (!storedUser) {
      return null;
    }

    const user = JSON.parse(storedUser);
    if (!user?.id || !user?.username || !user?.role) {
      return null;
    }

    return user;
  } catch {
    return null;
  }
}

export function storeUser(user) {
  window.localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(user));
}

export function clearStoredUser() {
  window.localStorage.removeItem(AUTH_STORAGE_KEY);
}

export {
  DEMO_INVESTIGATOR_PASSWORD,
  DEMO_SENIOR_PASSWORD,
  INVESTIGATOR_USERNAMES,
  SENIOR_USERNAMES,
};
