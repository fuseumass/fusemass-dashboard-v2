"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
import { useUser } from "@/lib/userContext";

export default function AdminMealsPage() {
    const user = useUser();
    const [meals, setMeals] = useState([]);
    const [name, setName] = useState("");
    const [startsAt, setStartsAt] = useState("");
    const [endsAt, setEndsAt] = useState("");
    const [msg, setMsg] = useState("");

    const load = () => apiFetch("/api/admin/meals").then((d) => setMeals(d.meals || []));
    
    useEffect(() => { if (user?.role === "admin") load(); }, [user]);

    if (user?.role !== "admin") return <p>Admins only.</p>;

    const handleCreate = async (e) => {
        e.preventDefault();
        try {
        await apiFetch("/api/admin/meals", {
            method: "POST",
            body: JSON.stringify({ 
            name, 
            startsAt: new Date(startsAt).toISOString(), 
            endsAt: new Date(endsAt).toISOString() 
            }),
        });
        setName(""); setStartsAt(""); setEndsAt(""); setMsg("Meal created!");
        load();
        } catch (err) { setMsg(err.message); }
    };

    const handleDelete = async (id) => {
        if (!confirm("Delete?")) return;
        await apiFetch(`/api/admin/meals/${id}`, { method: "DELETE" });
        load();
    };

    return (
        <div>
        <h1>Meal Services</h1>
        {msg && <p>{msg}</p>}
        
        <form onSubmit={handleCreate} style={{ marginBottom: "2rem", display: "grid", gap: "0.5rem", maxWidth: 400 }}>
            <input placeholder="Meal name (e.g. Saturday Lunch)" value={name} onChange={e => setName(e.target.value)} required />
            <input type="datetime-local" value={startsAt} onChange={e => setStartsAt(e.target.value)} required />
            <input type="datetime-local" value={endsAt} onChange={e => setEndsAt(e.target.value)} required />
            <button type="submit">Create Meal</button>
        </form>

        <h2>Existing Meals</h2>
        <ul>
            {meals.map(m => (
            <li key={m._id} style={{ marginBottom: "0.5rem" }}>
                <strong>{m.name}</strong> — {new Date(m.startsAt).toLocaleString()} to {new Date(m.endsAt).toLocaleString()}
                <button onClick={() => handleDelete(m._id)} style={{ marginLeft: "1rem" }}>Delete</button>
            </li>
            ))}
        </ul>
        </div>
    );
    }