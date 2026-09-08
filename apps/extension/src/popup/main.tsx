import React from "react";
import { createRoot } from "react-dom/client";
import { JudgeDashboard } from "./JudgeDashboard.js";

const root = document.getElementById("root")!;
createRoot(root).render(<JudgeDashboard />);
