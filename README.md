<p align="center">
  <img src="icons/icon128.png" width="96" alt="Video Catcher logo">
</p>

<h1 align="center">Video Catcher</h1>

<p align="center" dir="rtl">
  תוסף Chrome לזיהוי ושמירת וידאו וכתוביות מתוך דפים נתמכים.
</p>

<h2 dir="rtl">מה התוסף עושה?</h2>

<p dir="rtl">
  <span dir="ltr">Video Catcher</span> מזהה זרמי וידאו שהדפדפן כבר טוען ומציג אותם בממשק צדדי פשוט. ניתן לבחור איכות, להוריד וידאו, להוריד כתוביות ולעקוב אחר התקדמות ההורדה.
</p>

<h3 dir="rtl">יכולות עיקריות</h3>

<ul dir="rtl">
  <li>זיהוי אוטומטי של זרמי <span dir="ltr">HLS</span> נתמכים</li>
  <li>בחירת איכות וידאו</li>
  <li>הצגת אומדן גודל לפני ההורדה</li>
  <li>הורדת וידאו ואודיו במקביל</li>
  <li>חיבור הווידאו והאודיו לקובץ אחד</li>
  <li>הורדת כתוביות כקובץ נפרד</li>
  <li>זיהוי שפת כתוביות לפי התוכן במקרים שבהם המטא־דאטה שגוי</li>
  <li>אפשרות לבטל הורדה פעילה</li>
  <li>ממשק <span dir="ltr">Side Panel</span> מובנה בתוך Chrome</li>
  <li>קובץ <span dir="ltr">Debug</span> לצורך איתור תקלות</li>
  <li>ללא עקיפת <span dir="ltr">DRM</span></li>
</ul>

<p dir="rtl"><strong>שימו לב:</strong> נכון לגרסה הנוכחית, הרשאות האתרים של התוסף מוגבלות ל־<code dir="ltr">*.ac.il</code> ולשרתי המדיה הנדרשים לצורך ההורדה.</p>

<h2 dir="rtl">צילומי מסך</h2>

<p align="center">
  <img src="screenshots/video-catcher-overview.png" alt="Video Catcher overview">
</p>

<h3 dir="rtl">ממשק הצד</h3>

<p align="center">
  <img src="screenshots/side-panel.png" width="360" alt="Video Catcher side panel">
</p>

<h2 dir="rtl">התקנה</h2>

<p dir="rtl">התוסף עדיין אינו מופץ דרך <span dir="ltr">Chrome Web Store</span>, ולכן ההתקנה מתבצעת ידנית.</p>

<h3 dir="rtl">התקנה דרך GitHub</h3>

<ol dir="rtl">
  <li>לחץ למעלה על <span dir="ltr"><strong>Code → Download ZIP</strong></span>.</li>
  <li>חלץ את קובץ ה־<span dir="ltr">ZIP</span> לתיקייה קבועה במחשב.</li>
  <li>פתח ב־Chrome את הכתובת הבאה:</li>
</ol>

```text
chrome://extensions
```

<ol dir="rtl" start="4">
  <li>הפעל את <span dir="ltr"><strong>Developer mode</strong></span>.</li>
  <li>לחץ על <span dir="ltr"><strong>Load unpacked</strong></span>.</li>
  <li>בחר את התיקייה שחילצת — התיקייה שבה נמצא <code dir="ltr">manifest.json</code>.</li>
  <li>מומלץ להצמיד את <span dir="ltr">Video Catcher</span> לסרגל הכלים דרך תפריט התוספים של Chrome.</li>
</ol>

<p dir="rtl"><strong>חשוב:</strong> אל תמחק או תעביר את תיקיית התוסף לאחר ההתקנה. Chrome טוען את התוסף ישירות ממנה.</p>

<h2 dir="rtl">שימוש</h2>

<ol dir="rtl">
  <li>פתח דף נתמך שמכיל וידאו.</li>
  <li>במידת הצורך, הפעל את הווידאו לכמה שניות כדי שמקור המדיה ייטען.</li>
  <li>לחץ על האייקון של <span dir="ltr"><strong>Video Catcher</strong></span>.</li>
  <li>ממשק ה־<span dir="ltr">Side Panel</span> ייפתח ויציג את הווידאו שזוהה.</li>
  <li>בחר איכות ולחץ על <strong>הורד וידאו</strong>.</li>
  <li>אם נמצאו כתוביות, ניתן להוריד אותן בנפרד מאזור הכתוביות.</li>
</ol>

<p dir="rtl">במהלך הורדת <span dir="ltr">HLS</span> התוסף מוריד את ערוצי הווידאו והאודיו במקביל ומציג את ההתקדמות. ניתן לבטל את ההורדה בכל שלב.</p>

<h2 dir="rtl">לא זוהה וידאו?</h2>

<ol dir="rtl">
  <li>רענן את הדף.</li>
  <li>הפעל את הווידאו לכמה שניות.</li>
  <li>סגור ופתח מחדש את ה־<span dir="ltr">Side Panel</span>.</li>
  <li>ודא שהאתר נמצא בטווח האתרים שבהם התוסף מורשה לפעול.</li>
</ol>

<p dir="rtl">אם עדיין קיימת בעיה, פתח <strong>פרטים טכניים</strong> בתוסף והורד את קובץ ה־<span dir="ltr">Debug</span>.</p>

<h3 dir="rtl">דיווח על תקלה</h3>

<p dir="rtl">אם פתחת <span dir="ltr">Issue</span> ב־GitHub, מומלץ לצרף:</p>

<ul dir="rtl">
  <li>תיאור קצר של מה ניסית לעשות</li>
  <li>מה ציפית שיקרה ומה קרה בפועל</li>
  <li>גרסת Chrome</li>
  <li>גרסת <span dir="ltr">Video Catcher</span></li>
  <li>קובץ ה־<span dir="ltr">Debug</span> מתוך <strong>פרטים טכניים → הורד Debug</strong></li>
</ul>

<p dir="rtl">קובץ ה־<span dir="ltr">Debug</span> מצנזר חתימות וטוקנים רגישים, אך עדיין מומלץ לעבור עליו לפני פרסום פומבי.</p>

<p dir="rtl"><a href="https://github.com/WillyW0nka99/VideoCatcher/issues/new">פתיחת תקלה חדשה ב־GitHub</a></p>

<h2 dir="rtl">עדכון לגרסה חדשה</h2>

<ol dir="rtl">
  <li>החלף את קבצי התוסף הישנים בקבצים החדשים, או חלץ את הגרסה לתיקייה חדשה.</li>
  <li>פתח את <code dir="ltr">chrome://extensions</code>.</li>
  <li>לחץ על <span dir="ltr"><strong>Reload</strong></span> בכרטיס של <span dir="ltr">Video Catcher</span>.</li>
</ol>

<p dir="rtl">אם השתמשת בתיקייה חדשה, הסר את הגרסה הישנה וטען מחדש באמצעות <span dir="ltr"><strong>Load unpacked</strong></span>.</p>

<h2 dir="rtl">מגבלות</h2>

<ul dir="rtl">
  <li>התוסף אינו עוקף <span dir="ltr">DRM</span> או מנגנוני הגנת תוכן.</li>
  <li>לא כל אתר או פורמט וידאו נתמכים.</li>
  <li>כתובות מדיה חתומות עשויות לפוג לאחר זמן מסוים; במקרה כזה יש לרענן את הדף ולזהות את הווידאו מחדש.</li>
  <li>הורדות ארוכות או באיכות גבוהה עשויות להשתמש בכמות משמעותית של זיכרון בזמן עיבוד הקובץ.</li>
</ul>

<h2 dir="rtl">פרטיות</h2>

<p dir="rtl"><span dir="ltr">Video Catcher</span> פועל מקומית בדפדפן. מידע טכני שנאסף לצורך זיהוי מדיה ו־<span dir="ltr">Debug</span> אינו נשלח על ידי התוסף לשרת חיצוני.</p>

<h2 dir="rtl">אחריות וזכויות יוצרים</h2>

<p dir="rtl">השימוש בתוסף הוא באחריות המשתמש בלבד ובכפוף לתנאי השימוש של האתר בו אתם גולשים. ייתכן שהתכנים מוגנים בזכויות יוצרים. אין להעתיק, להפיץ או לשתף תוכן ללא הרשאה מתאימה מבעל הזכויות.</p>

<h2 dir="rtl">רישיון</h2>

<p dir="rtl">הפרויקט מופץ תחת רישיון <span dir="ltr">MIT</span>. ראו <a href="LICENSE"><span dir="ltr">LICENSE</span></a>.</p>

<hr>

<p dir="rtl"><strong>גרסה נוכחית:</strong> <code dir="ltr">v0.5.1</code></p>
