import {
    ShieldCheck
} from 'lucide-react';



export default function Play() {
    return (
        <section id="me" className="scr on">
            {/* Header with Title and Sign Out Button */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "4px" }}>
                <h1 className="hd" style={{ margin: 0 }}>PROFILE</h1>
                
            </div>

            {/* User Info Card */}
            <div className="card" style={{ marginTop: "14px", display: "flex", alignItems: "center", gap: "16px" }}>
                <span className="av" style={{ width: "64px", height: "64px", fontSize: "24px", display: "flex", alignItems: "center", justifyContent: "center", borderRadius: "50%", backgroundColor: "#a8d5ba", color: "#1a3322", fontWeight: 600 }}>Y</span>
                <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                    <b style={{ fontSize: "18px" }}>You</b>
                    <span className="mut" style={{ fontSize: "14px" }}>Rating 1420</span>
                </div>
            </div>

            {/* Average Accuracy Stats Card */}
            <div className="card" style={{ marginTop: "14px", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", textAlign: "center", padding: "32px 24px" }}>
                <span style={{color: "#1a2f23", font:"500 16px/1.4 \"Plus Jakarta Sans\", system-ui, sans-serif" }}>Average accuracy</span>
                <div style={{ width: "28px", height: "4px", backgroundColor: "#1a2f23", borderRadius: "9999px", margin: "20px 0" }}></div>
                <span className="mut" style={{ font:"400 14px/1.4 \"Plus Jakarta Sans\", system-ui, sans-serif" }}>Over 0 rated matches</span>
            </div>
        </section>
    );
}