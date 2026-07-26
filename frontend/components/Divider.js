// "or" divider used between the Google button and the email form.
export default function Divider({ label = "or" }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "0.75rem",
        margin: "1.1rem 0",
      }}
    >
      <span style={{ flex: 1, height: 1, background: "var(--border)" }} />
      <span className="muted" style={{ fontSize: "0.8rem" }}>
        {label}
      </span>
      <span style={{ flex: 1, height: 1, background: "var(--border)" }} />
    </div>
  );
}
