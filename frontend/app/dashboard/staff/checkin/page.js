"use client";

import {useEffect, useState} from "react";
import {apiFetch} from "@/lib/api";
import {useUser} from "@/lib/userContext";

export default function StaffCheckinPage() {
    const user = useUser();
    const [meals, setMeals] = useState([]);
    const [mealId, setMealId] = useState("");
    const [userId, setUserId] = useState("");
    const [msg, setMsg] = useState("");

    useEffect(() => {
        if (user?.role === "moderator" || user?.role === "admin") {
        apiFetch("/api/staff/meals")
            .then((data) => {
            const activeMeals = (data.meals || []).filter((m) => m.active);
            setMeals(activeMeals);
            if (activeMeals.length > 0) setMealId(activeMeals[0]._id);
            })
            .catch((err) => setMsg(err.message));
        }
    }, [user]);

    if (user?.role !== "moderator" && user?.role !== "admin") {
        return <p>Staff only.</p>;
    }

    const handleCheckin = async (e) => {
        e.preventDefault();
        setMsg("");
        try {
        await apiFetch(`/api/staff/meals/${mealId}/checkin`, {
            method: "POST",
            body: JSON.stringify({ userId }),
        });
        setMsg("Check-in successful!");
        setUserId("");
        } catch (err) {
        setMsg(err.message); // This will show "User already checked in..." if they double-serve!
        }
    };

    return (
        <div>
        <h1>Meal Check-In</h1>
        {msg && <p style={{ fontWeight: "bold", color: msg.includes("successful") ? "green" : "red" }}>{msg}</p>}
        
        {meals.length === 0 ? (
            <p>No active meal services right now. Ask an admin to create one.</p>
        ) : (
            <form onSubmit={handleCheckin} style={{ display: "grid", gap: "1rem", maxWidth: 400 }}>
            <label>
                Select Meal:
                <select value={mealId} onChange={(e) => setMealId(e.target.value)} style={{ width: "100%", padding: "0.5rem" }}>
                {meals.map((m) => (
                    <option key={m._id} value={m._id}>{m.name}</option>
                ))}
                </select>
            </label>
            
            <label>
                Participant User ID:
                <input 
                type="text" 
                value={userId} 
                onChange={(e) => setUserId(e.target.value)} 
                placeholder="Paste user _id here"
                required 
                style={{ width: "100%", padding: "0.5rem" }}
                />
            </label>
            
            <button type="submit" style={{ padding: "0.5rem", cursor: "pointer" }}>
                Check In
            </button>
            </form>
        )}
        </div>
    );
}