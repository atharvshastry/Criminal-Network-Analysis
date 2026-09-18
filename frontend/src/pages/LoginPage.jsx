import React from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import useAuth from "../hooks/useAuth";

export default function LoginPage() {
  const { isAuthenticated, login, isLoading } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [username, setUsername] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [showPassword, setShowPassword] = React.useState(false);
  const [error, setError] = React.useState("");

  if (isAuthenticated) {
    return <Navigate to="/" replace />;
  }

  const handleSubmit = async (event) => {
    event.preventDefault();
    const trimmedUsername = username.trim();

    if (!trimmedUsername || !password) {
      setError("Enter your username and password to continue.");
      return;
    }

    setError("");
    try {
      await login(trimmedUsername, password);
      const destination = location.state?.from?.pathname || "/";
      navigate(destination, { replace: true });
    } catch (loginError) {
      setError(loginError.message || "Unable to sign in.");
    }
  };

  return (
    <main className="login-page">
      <div className="login-atmosphere" aria-hidden="true" />
      <section className="login-card" aria-labelledby="login-title">
        <div className="login-brand">
          <span className="login-brand-mark">TraceX</span>
          <span className="login-brand-sub">Investigation Intelligence</span>
        </div>

        <div className="login-heading">
          <div className="eyebrow">Investigator access</div>
          <h1 id="login-title">Sign in to your workspace</h1>
          <p>Access network intelligence, case context, and investigative leads.</p>
        </div>

        <form className="login-form" onSubmit={handleSubmit} noValidate>
          <label htmlFor="username">Username or email</label>
          <input
            id="username"
            name="username"
            type="text"
            autoComplete="username"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            placeholder="Enter your username"
            disabled={isLoading}
          />

          <label htmlFor="password">Password</label>
          <div className="password-field">
            <input
              id="password"
              name="password"
              type={showPassword ? "text" : "password"}
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="Enter your password"
              disabled={isLoading}
            />
            <button
              type="button"
              className="password-toggle"
              onClick={() => setShowPassword((visible) => !visible)}
              aria-label={showPassword ? "Hide password" : "Show password"}
              disabled={isLoading}
            >
              {showPassword ? "Hide" : "Show"}
            </button>
          </div>

          {error && <div className="login-error" role="alert">{error}</div>}

          <button type="submit" className="login-submit" disabled={isLoading}>
            {isLoading ? "Authenticating…" : "Sign In"}
          </button>
        </form>

        <div className="login-session-note">
          <span className="security-dot" aria-hidden="true" />
          <span>Authenticated investigator session</span>
        </div>

      </section>
    </main>
  );
}
