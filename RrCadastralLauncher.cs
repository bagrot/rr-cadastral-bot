using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace RrCadastralBot
{
    public class LogView : ScrollableControl
    {
        private readonly List<string> lines = new List<string>();
        private readonly Font logFont = new Font("Cascadia Mono", 9.5F);

        public LogView()
        {
            DoubleBuffered = true;
            AutoScroll = true;
            BackColor = Color.FromArgb(15, 18, 23);
            ForeColor = Color.FromArgb(224, 229, 236);
        }

        public void AppendLine(string text)
        {
            lines.Add(text ?? "");
            var lineHeight = Math.Max(18, logFont.Height + 4);
            AutoScrollMinSize = new Size(0, Math.Max(Height, lines.Count * lineHeight + 28));
            AutoScrollPosition = new Point(0, AutoScrollMinSize.Height);
            Invalidate();
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e);
            var g = e.Graphics;
            var state = g.Save();
            g.ResetTransform();
            g.Clear(BackColor);
            g.Restore(state);

            if (lines.Count == 0)
            {
                var center = new Rectangle(0, 0, Width, Height);
                using (var titleFont = new Font("Segoe UI Semibold", 18F))
                using (var hintFont = new Font("Segoe UI", 10.5F))
                using (var titleBrush = new SolidBrush(Color.FromArgb(235, 238, 243)))
                using (var hintBrush = new SolidBrush(Color.FromArgb(137, 146, 158)))
                {
                    TextRenderer.DrawText(g, "Готов к сбору данных", titleFont, center, titleBrush.Color,
                        TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter);
                    var hint = new Rectangle(0, Height / 2 + 28, Width, 32);
                    TextRenderer.DrawText(g, "Проверьте N2 в таблице и нажмите «Начать полный сбор»", hintFont, hint, hintBrush.Color,
                        TextFormatFlags.HorizontalCenter | TextFormatFlags.Top);
                }
                return;
            }

            var y = AutoScrollPosition.Y + 14;
            using (var textBrush = new SolidBrush(ForeColor))
            using (var mutedBrush = new SolidBrush(Color.FromArgb(137, 146, 158)))
            using (var progressBrush = new SolidBrush(Color.FromArgb(103, 154, 255)))
            using (var errorBrush = new SolidBrush(Color.FromArgb(255, 113, 113)))
            {
                for (int i = 0; i < lines.Count; i++)
                {
                    var text = lines[i];
                    Brush brush = textBrush;
                    if (text.StartsWith("===")) brush = mutedBrush;
                    else if (text.StartsWith("[PROGRESS]")) brush = progressBrush;
                    else if (text.IndexOf("ОШИБКА", StringComparison.OrdinalIgnoreCase) >= 0 ||
                             text.IndexOf("ошибка", StringComparison.OrdinalIgnoreCase) >= 0) brush = errorBrush;
                    else if (text.IndexOf("НСПД завершена", StringComparison.OrdinalIgnoreCase) >= 0) brush = mutedBrush;
                    g.DrawString(text, logFont, brush, new RectangleF(18, y, Width - 42, logFont.Height + 8));
                    y += Math.Max(18, logFont.Height + 4);
                }
            }
        }

    }

    public class ModernButton : Button
    {
        public Color ButtonColor { get; set; }
        public Color ButtonColor2 { get; set; }
        public Color HoverColor { get; set; }
        public Color DownColor { get; set; }
        public bool UseGradient { get; set; }

        private bool hovered;
        private bool pressed;

        public ModernButton()
        {
            FlatStyle = FlatStyle.Flat;
            FlatAppearance.BorderSize = 0;
            Cursor = Cursors.Hand;
            ForeColor = Color.White;
            Font = new Font("Segoe UI Semibold", 9.5F);
            Height = 34;
            DoubleBuffered = true;
            ButtonColor = Color.FromArgb(31, 37, 46);
            ButtonColor2 = ButtonColor;
            HoverColor = Color.FromArgb(42, 50, 62);
            DownColor = Color.FromArgb(25, 30, 38);
        }

        protected override void OnMouseEnter(EventArgs e)
        {
            hovered = true;
            Invalidate();
            base.OnMouseEnter(e);
        }

        protected override void OnMouseLeave(EventArgs e)
        {
            hovered = false;
            pressed = false;
            Invalidate();
            base.OnMouseLeave(e);
        }

        protected override void OnMouseDown(MouseEventArgs mevent)
        {
            pressed = true;
            Invalidate();
            base.OnMouseDown(mevent);
        }

        protected override void OnMouseUp(MouseEventArgs mevent)
        {
            pressed = false;
            Invalidate();
            base.OnMouseUp(mevent);
        }

        protected override void OnPaint(PaintEventArgs pevent)
        {
            pevent.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            pevent.Graphics.Clear(Parent != null ? Parent.BackColor : BackColor);
            var rect = new Rectangle(0, 0, Width - 1, Height - 1);
            var color = pressed ? DownColor : (hovered ? HoverColor : ButtonColor);
            using (var path = RoundedRect(rect, 8))
            {
                if (UseGradient && !pressed)
                {
                    var second = hovered ? ControlPaint.Light(ButtonColor2, 0.08F) : ButtonColor2;
                    using (var brush = new LinearGradientBrush(rect, color, second, 0F))
                        pevent.Graphics.FillPath(brush, path);
                }
                else
                {
                    using (var brush = new SolidBrush(color))
                        pevent.Graphics.FillPath(brush, path);
                }
            }

            TextRenderer.DrawText(
                pevent.Graphics,
                Text,
                Font,
                rect,
                ForeColor,
                TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.EndEllipsis);
        }

        private static GraphicsPath RoundedRect(Rectangle bounds, int radius)
        {
            var diameter = radius * 2;
            var path = new GraphicsPath();
            path.AddArc(bounds.X, bounds.Y, diameter, diameter, 180, 90);
            path.AddArc(bounds.Right - diameter, bounds.Y, diameter, diameter, 270, 90);
            path.AddArc(bounds.Right - diameter, bounds.Bottom - diameter, diameter, diameter, 0, 90);
            path.AddArc(bounds.X, bounds.Bottom - diameter, diameter, diameter, 90, 90);
            path.CloseFigure();
            return path;
        }
    }

    public class ModernProgressBar : Control
    {
        private int progressValue;
        public int Minimum { get; set; }
        public int Maximum { get; set; }
        public Color TrackColor { get; set; }
        public Color ProgressColor { get; set; }

        public int Value
        {
            get { return progressValue; }
            set
            {
                progressValue = Math.Max(Minimum, Math.Min(Maximum, value));
                Invalidate();
            }
        }

        public ModernProgressBar()
        {
            Minimum = 0;
            Maximum = 100;
            TrackColor = Color.FromArgb(35, 40, 49);
            ProgressColor = Color.FromArgb(91, 140, 255);
            Height = 8;
            DoubleBuffered = true;
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            var track = new Rectangle(0, 0, Math.Max(1, Width - 1), Math.Max(1, Height - 1));
            using (var trackPath = RoundedRect(track, Math.Max(2, Height / 2)))
            using (var trackBrush = new SolidBrush(TrackColor))
                e.Graphics.FillPath(trackBrush, trackPath);
            var range = Math.Max(1, Maximum - Minimum);
            var width = (int)Math.Round(track.Width * (Value - Minimum) / (double)range);
            if (width > 0)
            {
                var fill = new Rectangle(track.X, track.Y, Math.Max(Height, width), track.Height);
                if (fill.Right > track.Right) fill.Width = track.Right - fill.Left;
                using (var fillPath = RoundedRect(fill, Math.Max(2, Height / 2)))
                using (var fillBrush = new SolidBrush(ProgressColor))
                    e.Graphics.FillPath(fillBrush, fillPath);
            }
        }

        private static GraphicsPath RoundedRect(Rectangle bounds, int radius)
        {
            var diameter = Math.Max(2, radius * 2);
            var path = new GraphicsPath();
            path.AddArc(bounds.X, bounds.Y, diameter, diameter, 180, 90);
            path.AddArc(bounds.Right - diameter, bounds.Y, diameter, diameter, 270, 90);
            path.AddArc(bounds.Right - diameter, bounds.Bottom - diameter, diameter, diameter, 0, 90);
            path.AddArc(bounds.X, bounds.Bottom - diameter, diameter, diameter, 90, 90);
            path.CloseFigure();
            return path;
        }
    }

    public class LauncherForm : Form
    {
        private readonly TextBox startRowBox = new TextBox();
        private readonly TextBox rangesBox = new TextBox();
        private readonly CheckBox refreshNspdBox = new CheckBox();
        private readonly LogView logBox = new LogView();
        private readonly Label statusLabel = new Label();
        private readonly Label progressDetailLabel = new Label();
        private readonly ModernProgressBar progressBar = new ModernProgressBar();
        private readonly List<Button> runButtons = new List<Button>();
        private readonly TextBox sheetsUrlBox = new TextBox();
        private readonly TextBox nspdUrlBox = new TextBox();
        private readonly TextBox rosreestrUrlBox = new TextBox();
        private readonly TextBox gisUrlBox = new TextBox();
        private readonly ToolTip toolTips = new ToolTip();
        private readonly Panel workspaceHost = new Panel();
        private readonly Dictionary<string, ModernButton> navigationButtons = new Dictionary<string, ModernButton>();
        private readonly ModernButton updateButton = new ModernButton();
        private Control activeWorkspacePage;
        private bool updateCheckInProgress;
        private string availableUpdateUrl;
        private string availableUpdateVersion;
        private string availableUpdateSha256;
        private Process runningProcess;
        private Button stopButton;
        private string sessionLogPath;

        private const string ChromePath = @"C:\Program Files\Google\Chrome\Application\chrome.exe";
        private const string ChromeArgs = @"--remote-debugging-port=9222 --user-data-dir=""C:\chrome-remote"" --profile-directory=Default";
        private const string CurrentVersion = "3.0.5";
        private const string UpdateApiUrl = "https://api.github.com/repos/bagrot/rr-cadastral-bot/releases/latest";
        private const string InstallerAssetName = "RR-Cadastral-Bot-Setup.exe";
        private readonly Color panelColor = Color.FromArgb(18, 22, 28);
        private readonly Color cardColor = Color.FromArgb(21, 26, 33);
        private readonly Color buttonColor = Color.FromArgb(30, 36, 45);
        private readonly Color buttonHoverColor = Color.FromArgb(42, 50, 62);
        private readonly Color buttonDownColor = Color.FromArgb(25, 30, 38);
        private readonly Color accentColor = Color.FromArgb(91, 140, 255);
        private readonly Color textColor = Color.FromArgb(238, 241, 246);
        private readonly Color mutedColor = Color.FromArgb(137, 146, 158);

        public LauncherForm()
        {
            Text = "Кадастробот " + CurrentVersion;
            Width = 1280;
            Height = 850;
            MinimumSize = new Size(1080, 780);
            StartPosition = FormStartPosition.CenterScreen;
            Font = new Font("Segoe UI", 9F);
            BackColor = Color.FromArgb(11, 14, 18);
            LoadConfigLinks();

            var root = new TableLayoutPanel
            {
                Dock = DockStyle.Fill,
                RowCount = 2,
                ColumnCount = 1,
                BackColor = BackColor,
                Margin = new Padding(0),
                Padding = new Padding(0)
            };
            root.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            root.RowStyles.Add(new RowStyle(SizeType.Absolute, 68));
            root.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
            Controls.Add(root);

            var header = new TableLayoutPanel
            {
                Dock = DockStyle.Fill,
                ColumnCount = 2,
                RowCount = 1,
                BackColor = Color.FromArgb(15, 18, 23),
                Padding = new Padding(24, 10, 24, 10),
                Margin = new Padding(0)
            };
            header.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            header.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 250));
            root.Controls.Add(header, 0, 0);

            var brandText = new TableLayoutPanel { Dock = DockStyle.Fill, RowCount = 2, ColumnCount = 1, Margin = new Padding(0) };
            brandText.RowStyles.Add(new RowStyle(SizeType.Percent, 60));
            brandText.RowStyles.Add(new RowStyle(SizeType.Percent, 40));
            brandText.Controls.Add(new Label { Text = "Кадастробот", Dock = DockStyle.Fill, TextAlign = ContentAlignment.BottomLeft, Font = new Font("Segoe UI Semibold", 17F), ForeColor = textColor });
            brandText.Controls.Add(new Label { Text = "Сбор кадастровых данных  ·  версия " + CurrentVersion, Dock = DockStyle.Fill, TextAlign = ContentAlignment.TopLeft, Font = new Font("Segoe UI", 9F), ForeColor = mutedColor });
            header.Controls.Add(brandText, 0, 0);

            updateButton.Text = "Проверить обновления";
            updateButton.Dock = DockStyle.Fill;
            updateButton.Margin = new Padding(12, 3, 0, 3);
            updateButton.ButtonColor = buttonColor;
            updateButton.HoverColor = buttonHoverColor;
            updateButton.DownColor = buttonDownColor;
            updateButton.ForeColor = textColor;
            updateButton.Click += async (sender, args) => await HandleUpdateButtonAsync();
            toolTips.SetToolTip(updateButton, "Проверить и скачать новую версию Кадастробота");
            header.Controls.Add(updateButton, 1, 0);

            var main = new TableLayoutPanel
            {
                Dock = DockStyle.Fill,
                ColumnCount = 2,
                RowCount = 1,
                Padding = new Padding(20, 18, 20, 20),
                BackColor = BackColor,
                Margin = new Padding(0)
            };
            main.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            main.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 410));
            root.Controls.Add(main, 0, 1);

            var left = new TableLayoutPanel
            {
                Dock = DockStyle.Fill,
                RowCount = 20,
                ColumnCount = 1,
                BackColor = panelColor,
                Padding = new Padding(22, 20, 22, 18),
                AutoScroll = true
            };
            for (int i = 0; i < 20; i++) left.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            main.Controls.Add(left, 1, 0);

            var title = new Label
            {
                Text = "Запуск",
                Font = new Font("Segoe UI Semibold", 17F),
                AutoSize = true,
                ForeColor = textColor,
                Margin = new Padding(0, 0, 0, 8)
            };
            left.Controls.Add(title);

            left.Controls.Add(MakeSectionLabel("Параметры"));
            left.Controls.Add(MakeLabel("Стартовая строка Google Sheets"));
            startRowBox.Text = "2";
            startRowBox.Dock = DockStyle.Top;
            StyleInput(startRowBox);
            startRowBox.Margin = new Padding(0, 0, 0, 9);
            left.Controls.Add(startRowBox);

            left.Controls.Add(MakeLabel("Строки для выборочной проверки"));
            rangesBox.Text = "2-122";
            rangesBox.Dock = DockStyle.Top;
            StyleInput(rangesBox);
            rangesBox.Margin = new Padding(0, 0, 0, 10);
            left.Controls.Add(rangesBox);

            refreshNspdBox.Text = "Обновить НСПД без кэша";
            refreshNspdBox.ForeColor = textColor;
            refreshNspdBox.BackColor = panelColor;
            refreshNspdBox.Font = new Font("Segoe UI", 9.5F);
            refreshNspdBox.AutoSize = true;
            refreshNspdBox.Margin = new Padding(0, 0, 0, 6);
            toolTips.SetToolTip(refreshNspdBox, "Перечитать все карточки НСПД. Обычно оставляйте выключенным.");
            left.Controls.Add(refreshNspdBox);

            left.Controls.Add(MakeSectionLabel("Подготовка"));
            var prepGrid = MakeGrid(2, 1, 44);
            var chromeButton = MakeButton("Открыть Chrome", StartChrome);
            var tabsButton = MakeButton("Открыть сервисы", OpenRequiredTabs);
            prepGrid.Controls.Add(chromeButton);
            prepGrid.Controls.Add(tabsButton);
            toolTips.SetToolTip(chromeButton, "Запустить отдельный Chrome с портом 9222");
            toolTips.SetToolTip(tabsButton, "Открыть рабочую таблицу, НСПД, Росреестр и ГИС ЖКХ");
            left.Controls.Add(prepGrid);

            left.Controls.Add(MakeSectionLabel("Основной режим"));
            AddRunButton(left, "Начать полный сбор", "full", true);
            var orderHint = new Label
            {
                Text = "Все сведения об объектах и доме",
                AutoSize = false,
                Dock = DockStyle.Top,
                Height = 20,
                TextAlign = ContentAlignment.MiddleCenter,
                ForeColor = mutedColor,
                Font = new Font("Segoe UI", 8.5F),
                Margin = new Padding(0, 0, 0, 4)
            };
            left.Controls.Add(orderHint);

            left.Controls.Add(MakeSectionLabel("Отдельные операции"));
            var modeGrid = MakeGrid(2, 3, 44);
            AddRunButton(modeGrid, "Данные НСПД", "nspd");
            AddRunButton(modeGrid, "Росреестр: все объекты", "rr");
            AddRunButton(modeGrid, "Росреестр: нежилые", "rr-nonres");
            AddRunButton(modeGrid, "Проверить строки", "rr-ranges");
            AddRunButton(modeGrid, "Общее имущество", "nspd-common");
            left.Controls.Add(modeGrid);

            stopButton = MakeButton("Остановить сбор", StopRunningProcess);
            ((ModernButton)stopButton).ButtonColor = Color.FromArgb(48, 38, 42);
            ((ModernButton)stopButton).HoverColor = Color.FromArgb(73, 45, 51);
            stopButton.Margin = new Padding(3, 5, 3, 5);
            stopButton.Enabled = false;
            left.Controls.Add(stopButton);

            progressBar.Minimum = 0;
            progressBar.Maximum = 100;
            progressBar.Value = 0;
            progressBar.Dock = DockStyle.Top;
            progressBar.Height = 8;
            progressBar.Margin = new Padding(0, 6, 0, 8);
            left.Controls.Add(progressBar);

            progressDetailLabel.Text = "Ожидание запуска";
            progressDetailLabel.ForeColor = mutedColor;
            progressDetailLabel.AutoSize = false;
            progressDetailLabel.Dock = DockStyle.Top;
            progressDetailLabel.Height = 22;
            left.Controls.Add(progressDetailLabel);

            statusLabel.Text = "Готов к запуску";
            statusLabel.ForeColor = accentColor;
            statusLabel.AutoSize = false;
            statusLabel.Dock = DockStyle.Top;
            statusLabel.Font = new Font("Segoe UI Semibold", 10F);
            statusLabel.Height = 26;
            left.Controls.Add(statusLabel);

            var workspace = new TableLayoutPanel
            {
                Dock = DockStyle.Fill,
                Margin = new Padding(0, 0, 16, 0),
                RowCount = 2,
                ColumnCount = 1,
                BackColor = panelColor,
                Padding = new Padding(0)
            };
            workspace.RowStyles.Add(new RowStyle(SizeType.Absolute, 58));
            workspace.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
            main.Controls.Add(workspace, 0, 0);

            var navigation = new FlowLayoutPanel
            {
                Dock = DockStyle.Fill,
                FlowDirection = FlowDirection.LeftToRight,
                WrapContents = false,
                BackColor = panelColor,
                Padding = new Padding(12, 10, 0, 8),
                Margin = new Padding(0)
            };
            workspace.Controls.Add(navigation, 0, 0);

            workspaceHost.Dock = DockStyle.Fill;
            workspaceHost.BackColor = Color.FromArgb(15, 18, 23);
            workspaceHost.BorderStyle = BorderStyle.FixedSingle;
            workspaceHost.Margin = new Padding(1, 0, 1, 1);
            workspace.Controls.Add(workspaceHost, 0, 1);

            var logPage = new Panel { Dock = DockStyle.Fill, BackColor = Color.FromArgb(15, 18, 23) };
            logBox.Dock = DockStyle.Fill;
            logPage.Controls.Add(logBox);

            var helpPage = new Panel { Dock = DockStyle.Fill, BackColor = cardColor, Padding = new Padding(28) };
            var help = new RichTextBox
            {
                Dock = DockStyle.Fill,
                ReadOnly = true,
                ScrollBars = RichTextBoxScrollBars.Vertical,
                Font = new Font("Segoe UI", 10.5F),
                Text = BuildHelpText(),
                BackColor = cardColor,
                ForeColor = textColor,
                BorderStyle = BorderStyle.None
            };
            helpPage.Controls.Add(help);

            var linksPage = BuildLinksPanel();
            workspaceHost.Controls.Add(logPage);
            workspaceHost.Controls.Add(helpPage);
            workspaceHost.Controls.Add(linksPage);
            logPage.Visible = true;
            helpPage.Visible = false;
            linksPage.Visible = false;

            var logNav = MakeNavigationButton("Журнал", "log", navigation);
            var helpNav = MakeNavigationButton("Инструкция", "help", navigation);
            var linksNav = MakeNavigationButton("Источники", "links", navigation);
            logNav.Click += (sender, args) => ShowWorkspacePage(logPage, "log");
            helpNav.Click += (sender, args) => ShowWorkspacePage(helpPage, "help");
            linksNav.Click += (sender, args) => ShowWorkspacePage(linksPage, "links");
            ShowWorkspacePage(logPage, "log");

            FormClosing += (sender, args) =>
            {
                if (runningProcess != null && !runningProcess.HasExited)
                {
                    var answer = MessageBox.Show("Бот еще работает. Остановить его и закрыть приложение?", "Кадастробот", MessageBoxButtons.YesNo, MessageBoxIcon.Question);
                    if (answer != DialogResult.Yes)
                    {
                        args.Cancel = true;
                        return;
                    }
                    StopRunningProcess();
                }
            };

            Shown += async (sender, args) => await CheckForUpdatesAsync(false);
        }

        private Label MakeLabel(string text)
        {
            return new Label
            {
                Text = text,
                AutoSize = true,
                ForeColor = textColor,
                Font = new Font("Segoe UI Semibold", 9F),
                Margin = new Padding(0, 0, 0, 4)
            };
        }

        private void StyleInput(TextBox box)
        {
            box.BackColor = Color.FromArgb(13, 16, 21);
            box.ForeColor = textColor;
            box.BorderStyle = BorderStyle.FixedSingle;
            box.Font = new Font("Segoe UI", 10.5F);
            box.Height = 34;
        }

        private ModernButton MakeNavigationButton(string text, string key, FlowLayoutPanel owner)
        {
            var button = new ModernButton
            {
                Text = text,
                Width = 130,
                Height = 36,
                Dock = DockStyle.None,
                Margin = new Padding(0, 0, 8, 0),
                ButtonColor = Color.FromArgb(24, 29, 36),
                HoverColor = Color.FromArgb(38, 45, 56),
                DownColor = Color.FromArgb(20, 24, 30),
                ForeColor = mutedColor
            };
            navigationButtons[key] = button;
            owner.Controls.Add(button);
            return button;
        }

        private void ShowWorkspacePage(Control page, string key)
        {
            if (activeWorkspacePage != null) activeWorkspacePage.Visible = false;
            page.Visible = true;
            page.BringToFront();
            activeWorkspacePage = page;
            foreach (var pair in navigationButtons)
            {
                var selected = pair.Key == key;
                pair.Value.ButtonColor = selected ? Color.FromArgb(53, 82, 145) : Color.FromArgb(24, 29, 36);
                pair.Value.ForeColor = selected ? textColor : mutedColor;
                pair.Value.Invalidate();
            }
        }

        private Label MakeSectionLabel(string text)
        {
            return new Label
            {
                Text = text,
                AutoSize = false,
                Height = 18,
                TextAlign = ContentAlignment.BottomLeft,
                ForeColor = mutedColor,
                Font = new Font("Segoe UI Semibold", 9F),
                Margin = new Padding(0, 5, 0, 5)
            };
        }

        private TableLayoutPanel MakeGrid(int columns, int rows, int rowHeight)
        {
            var grid = new TableLayoutPanel
            {
                ColumnCount = columns,
                RowCount = rows,
                Dock = DockStyle.Top,
                Height = rows * rowHeight,
                Margin = new Padding(0),
                BackColor = panelColor
            };
            for (int i = 0; i < columns; i++) grid.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100F / columns));
            for (int i = 0; i < rows; i++) grid.RowStyles.Add(new RowStyle(SizeType.Absolute, rowHeight));
            return grid;
        }

        private ModernButton MakeButton(string text, Action click)
        {
            var button = new ModernButton
            {
                Text = text,
                Dock = DockStyle.Fill,
                ButtonColor = buttonColor,
                HoverColor = buttonHoverColor,
                DownColor = buttonDownColor,
                Margin = new Padding(3)
            };
            button.Click += (sender, args) => click();
            return button;
        }

        private void AddRunButton(TableLayoutPanel panel, string text, string mode, bool primary = false)
        {
            var button = MakeButton(text, () => RunBot(mode));
            if (primary)
            {
                button.Height = 46;
                button.ButtonColor = accentColor;
                button.ButtonColor2 = accentColor;
                button.UseGradient = false;
                button.HoverColor = Color.FromArgb(111, 157, 255);
                button.DownColor = Color.FromArgb(72, 113, 210);
                button.ForeColor = Color.White;
                button.Font = new Font("Segoe UI Semibold", 10F);
            }
            runButtons.Add(button);
            panel.Controls.Add(button);
            var hint = mode == "full" ? "Собрать все доступные сведения об объектах и доме" :
                mode == "nspd" ? "Полностью перечитать A:H из НСПД" :
                mode == "rr" ? "Обновить форму собственности и регистрационные сведения для всех строк" :
                mode == "rr-nonres" ? "Обновить сведения Росреестра только для нежилых помещений" :
                mode == "rr-ranges" ? "Обновить сведения Росреестра только в указанном диапазоне строк" :
                "Проверить признак общего имущества только у нежилых помещений";
            toolTips.SetToolTip(button, hint);
        }

        private sealed class UpdateInfo
        {
            public string Version { get; set; }
            public string DownloadUrl { get; set; }
            public string Sha256 { get; set; }
        }

        private async Task HandleUpdateButtonAsync()
        {
            if (string.IsNullOrWhiteSpace(availableUpdateUrl))
            {
                await CheckForUpdatesAsync(true);
                return;
            }

            if (runningProcess != null && !runningProcess.HasExited)
            {
                MessageBox.Show(
                    "Сейчас идёт сбор данных. Дождитесь завершения или остановите сбор, затем запустите обновление.",
                    "Обновление отложено",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Information);
                return;
            }

            var answer = MessageBox.Show(
                "Скачать Кадастробот " + availableUpdateVersion + " и запустить установку?\n\nПосле загрузки приложение закроется, а установщик откроется автоматически.",
                "Доступно обновление",
                MessageBoxButtons.YesNo,
                MessageBoxIcon.Question);
            if (answer != DialogResult.Yes) return;

            await DownloadAndRunUpdateAsync();
        }

        private async Task CheckForUpdatesAsync(bool manual)
        {
            if (updateCheckInProgress) return;
            updateCheckInProgress = true;
            updateButton.Enabled = false;
            updateButton.Text = "Проверяю обновление...";

            try
            {
                var info = await Task.Run(() => GetLatestUpdate());
                Version current;
                Version latest;
                if (!Version.TryParse(CurrentVersion, out current) ||
                    !Version.TryParse(NormalizeVersion(info.Version), out latest))
                    throw new InvalidOperationException("GitHub вернул некорректный номер версии.");

                if (latest > current)
                {
                    availableUpdateUrl = info.DownloadUrl;
                    availableUpdateVersion = latest.ToString();
                    availableUpdateSha256 = info.Sha256;
                    updateButton.Text = "Обновить до " + availableUpdateVersion;
                    updateButton.ButtonColor = Color.FromArgb(45, 126, 87);
                    updateButton.HoverColor = Color.FromArgb(54, 148, 102);
                    updateButton.DownColor = Color.FromArgb(36, 104, 71);
                    updateButton.Enabled = true;
                    toolTips.SetToolTip(updateButton, "Нажмите, чтобы скачать и установить новую версию");
                    AppendLog("Доступно обновление Кадастробота: " + availableUpdateVersion + ".");
                }
                else
                {
                    availableUpdateUrl = null;
                    availableUpdateVersion = null;
                    availableUpdateSha256 = null;
                    updateButton.Text = "Версия " + CurrentVersion + " актуальна";
                    updateButton.ButtonColor = buttonColor;
                    updateButton.HoverColor = buttonHoverColor;
                    updateButton.DownColor = buttonDownColor;
                    updateButton.Enabled = true;
                    toolTips.SetToolTip(updateButton, "Нажмите, чтобы проверить обновления ещё раз");
                    if (manual)
                        MessageBox.Show("У вас установлена последняя версия.", "Обновления", MessageBoxButtons.OK, MessageBoxIcon.Information);
                }
            }
            catch (Exception ex)
            {
                availableUpdateUrl = null;
                availableUpdateVersion = null;
                availableUpdateSha256 = null;
                updateButton.Text = "Проверить обновления";
                updateButton.ButtonColor = buttonColor;
                updateButton.HoverColor = buttonHoverColor;
                updateButton.DownColor = buttonDownColor;
                updateButton.Enabled = true;
                if (manual)
                {
                    MessageBox.Show(
                        "Не удалось проверить обновление.\n\n" + ex.Message,
                        "Проверка обновлений",
                        MessageBoxButtons.OK,
                        MessageBoxIcon.Warning);
                }
            }
            finally
            {
                updateCheckInProgress = false;
            }
        }

        private UpdateInfo GetLatestUpdate()
        {
            ServicePointManager.SecurityProtocol |= SecurityProtocolType.Tls12;
            var request = (HttpWebRequest)WebRequest.Create(UpdateApiUrl);
            request.Method = "GET";
            request.UserAgent = "KadastrBot-Updater/" + CurrentVersion;
            request.Accept = "application/vnd.github+json";
            request.Timeout = 15000;
            request.ReadWriteTimeout = 15000;

            string json;
            using (var response = (HttpWebResponse)request.GetResponse())
            using (var stream = response.GetResponseStream())
            using (var reader = new StreamReader(stream, Encoding.UTF8))
                json = reader.ReadToEnd();

            var tagMatch = Regex.Match(json, "\\\"tag_name\\\"\\s*:\\s*\\\"([^\\\"]+)\\\"");
            if (!tagMatch.Success) throw new InvalidOperationException("В последнем релизе не указан номер версии.");

            var assetPattern = "\\\"name\\\"\\s*:\\s*\\\"" + Regex.Escape(InstallerAssetName) +
                "\\\"[\\s\\S]*?\\\"digest\\\"\\s*:\\s*\\\"sha256:([a-fA-F0-9]{64})\\\"[\\s\\S]*?" +
                "\\\"browser_download_url\\\"\\s*:\\s*\\\"([^\\\"]+)\\\"";
            var assetMatch = Regex.Match(json, assetPattern);
            if (!assetMatch.Success)
                throw new InvalidOperationException("В последнем релизе нет файла " + InstallerAssetName + ".");
            var expectedSha256 = assetMatch.Groups[1].Value.ToUpperInvariant();
            var installerUrl = assetMatch.Groups[2].Value.Replace("\\/", "/");

            Uri downloadUri;
            if (!Uri.TryCreate(installerUrl, UriKind.Absolute, out downloadUri) ||
                downloadUri.Scheme != Uri.UriSchemeHttps ||
                !downloadUri.Host.Equals("github.com", StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("GitHub вернул небезопасную ссылку на установщик.");

            return new UpdateInfo
            {
                Version = NormalizeVersion(tagMatch.Groups[1].Value),
                DownloadUrl = installerUrl,
                Sha256 = expectedSha256
            };
        }

        private string NormalizeVersion(string value)
        {
            var match = Regex.Match(value ?? "", @"\d+(?:\.\d+){1,3}");
            return match.Success ? match.Value : "";
        }

        private async Task DownloadAndRunUpdateAsync()
        {
            var version = string.IsNullOrWhiteSpace(availableUpdateVersion) ? "latest" : availableUpdateVersion;
            var target = Path.Combine(Path.GetTempPath(), "KadastrBot-Update-" + version.Replace('.', '-') + ".exe");
            updateButton.Enabled = false;
            updateButton.Text = "Начинаю загрузку...";

            try
            {
                using (var client = new WebClient())
                {
                    client.Headers.Add(HttpRequestHeader.UserAgent, "KadastrBot-Updater/" + CurrentVersion);
                    client.DownloadProgressChanged += (sender, args) =>
                    {
                        if (!IsDisposed && IsHandleCreated)
                            BeginInvoke(new Action(() => updateButton.Text = "Загрузка " + args.ProgressPercentage + "%"));
                    };
                    await client.DownloadFileTaskAsync(new Uri(availableUpdateUrl), target);
                }

                var file = new FileInfo(target);
                if (!file.Exists || file.Length < 1024 * 1024)
                    throw new InvalidOperationException("Загруженный установщик повреждён или имеет неверный размер.");

                string actualSha256;
                using (var sha256 = SHA256.Create())
                using (var stream = File.OpenRead(target))
                    actualSha256 = BitConverter.ToString(sha256.ComputeHash(stream)).Replace("-", "");
                if (string.IsNullOrWhiteSpace(availableUpdateSha256) ||
                    !actualSha256.Equals(availableUpdateSha256, StringComparison.OrdinalIgnoreCase))
                    throw new InvalidOperationException("Контрольная сумма установщика не совпала с данными GitHub.");

                updateButton.Text = "Запускаю установщик...";
                Process.Start(new ProcessStartInfo
                {
                    FileName = target,
                    UseShellExecute = true
                });
                BeginInvoke(new Action(Close));
            }
            catch (Exception ex)
            {
                updateButton.Text = "Обновить до " + availableUpdateVersion;
                updateButton.Enabled = true;
                MessageBox.Show(
                    "Не удалось скачать обновление.\n\n" + ex.Message,
                    "Ошибка обновления",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error);
            }
        }

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            try
            {
                var enabled = 1;
                DwmSetWindowAttribute(Handle, 20, ref enabled, sizeof(int));
                DwmSetWindowAttribute(Handle, 19, ref enabled, sizeof(int));
            }
            catch { }
        }

        [DllImport("dwmapi.dll")]
        private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);

        private string BaseDir()
        {
            return AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);
        }

        private string ConfigPath()
        {
            return Path.Combine(BaseDir(), "config.js");
        }

        private string BundledNodePath()
        {
            return Path.Combine(BaseDir(), "runtime", "node.exe");
        }

        private void AppendLog(string text)
        {
            if (InvokeRequired)
            {
                BeginInvoke(new Action<string>(AppendLog), text);
                return;
            }
            logBox.AppendLine(text);
            UpdateProgressFromLog(text);
            if (!string.IsNullOrWhiteSpace(sessionLogPath))
            {
                try { File.AppendAllText(sessionLogPath, (text ?? "") + Environment.NewLine, new UTF8Encoding(false)); }
                catch { }
            }
        }

        private void UpdateProgressFromLog(string text)
        {
            var match = Regex.Match(text ?? "", @"^\[PROGRESS\]\s+(.+?)\s+(\d+)\/(\d+)(.*)$");
            if (!match.Success) return;
            int current;
            int total;
            if (!int.TryParse(match.Groups[2].Value, out current) || !int.TryParse(match.Groups[3].Value, out total) || total <= 0) return;
            progressBar.Value = Math.Max(0, Math.Min(100, (int)Math.Round(current * 100.0 / total)));
            progressDetailLabel.Text = match.Groups[1].Value + ": " + current + " из " + total + match.Groups[4].Value;
        }

        private void SetRunningUi(bool running)
        {
            if (InvokeRequired)
            {
                BeginInvoke(new Action<bool>(SetRunningUi), running);
                return;
            }
            foreach (var button in runButtons) button.Enabled = !running;
            if (stopButton != null) stopButton.Enabled = running;
            if (running)
            {
                progressBar.Value = 0;
                progressDetailLabel.Text = "Подготовка...";
            }
        }

        private void SetStatus(string text)
        {
            if (InvokeRequired)
            {
                BeginInvoke(new Action<string>(SetStatus), text);
                return;
            }
            statusLabel.Text = text;
        }

        private void LoadConfigLinks()
        {
            sheetsUrlBox.Text = ReadConfigValue("sheetsUrl", "https://docs.google.com/spreadsheets/d/1Hl00tLipe3zZmLEHUdUi1E_VWKJNSTgIUUA731j_9Ts/edit?gid=0#gid=0");
            nspdUrlBox.Text = ReadConfigValue("nspdUrl", "https://nspd.gov.ru/map?thematic=PKK&theme_id=1&baseLayerId=235&is_copy_url=true&zoom=5&coordinate_x=7804891.637510094&coordinate_y=8181287.398947453");
            rosreestrUrlBox.Text = ReadConfigValue("rosreestrUrl", "https://lk.rosreestr.ru/eservices/real-estate-objects-online");
            gisUrlBox.Text = ReadConfigValue("gisUrl", "https://dom.gosuslugi.ru/#!/houses");
        }

        private string ReadConfigValue(string key, string fallback)
        {
            try
            {
                var path = ConfigPath();
                if (!File.Exists(path)) return fallback;
                var text = File.ReadAllText(path, Encoding.UTF8);
                var match = Regex.Match(text, Regex.Escape(key) + @"\s*:\s*(['""])(.*?)\1", RegexOptions.Singleline);
                if (!match.Success) return fallback;
                return UnescapeJs(match.Groups[2].Value);
            }
            catch
            {
                return fallback;
            }
        }

        private Control BuildLinksPanel()
        {
            var outer = new Panel
            {
                Dock = DockStyle.Fill,
                BackColor = cardColor,
                Padding = new Padding(28)
            };

            var table = new TableLayoutPanel
            {
                Dock = DockStyle.Top,
                AutoSize = true,
                ColumnCount = 1
            };
            outer.Controls.Add(table);

            var title = new Label
            {
                Text = "Редактирование ссылок",
                Font = new Font("Segoe UI Semibold", 16F),
                AutoSize = true,
                ForeColor = textColor,
                Margin = new Padding(0, 0, 0, 6)
            };
            table.Controls.Add(title);

            var hint = new Label
            {
                Text = "Здесь можно заменить Google-таблицу или рабочие страницы сервисов. После изменения нажмите «Сохранить ссылки».",
                AutoSize = false,
                Height = 42,
                ForeColor = mutedColor,
                Margin = new Padding(0, 0, 0, 12)
            };
            table.Controls.Add(hint);

            AddLinkEditor(table, "Google Sheets", sheetsUrlBox);
            AddLinkEditor(table, "НСПД", nspdUrlBox);
            AddLinkEditor(table, "Росреестр", rosreestrUrlBox);
            AddLinkEditor(table, "ГИС ЖКХ", gisUrlBox);

            var buttons = new FlowLayoutPanel
            {
                FlowDirection = FlowDirection.LeftToRight,
                AutoSize = true,
                Dock = DockStyle.Top,
                Margin = new Padding(0, 8, 0, 0)
            };

            var save = MakeButton("Сохранить ссылки", SaveConfigLinks);
            save.Width = 180;
            save.Dock = DockStyle.None;
            save.Margin = new Padding(0, 0, 10, 0);
            buttons.Controls.Add(save);

            var reload = MakeButton("Загрузить из config.js", LoadConfigLinks);
            reload.Width = 190;
            reload.Dock = DockStyle.None;
            reload.Margin = new Padding(0);
            buttons.Controls.Add(reload);

            table.Controls.Add(buttons);
            return outer;
        }

        private void AddLinkEditor(TableLayoutPanel table, string labelText, TextBox box)
        {
            var label = MakeLabel(labelText);
            label.Margin = new Padding(0, 4, 0, 4);
            table.Controls.Add(label);

            box.Dock = DockStyle.Top;
            box.Width = 580;
            StyleInput(box);
            box.Margin = new Padding(0, 0, 0, 10);
            table.Controls.Add(box);
        }

        private void SaveConfigLinks()
        {
            try
            {
                var path = ConfigPath();
                if (!File.Exists(path))
                {
                    MessageBox.Show("Не найден config.js рядом с приложением:\n" + path, "Файл не найден", MessageBoxButtons.OK, MessageBoxIcon.Error);
                    return;
                }

                var text = File.ReadAllText(path, Encoding.UTF8);
                text = SetConfigValue(text, "sheetsUrl", sheetsUrlBox.Text.Trim());
                text = SetConfigValue(text, "nspdUrl", nspdUrlBox.Text.Trim());
                text = SetConfigValue(text, "rosreestrUrl", rosreestrUrlBox.Text.Trim());
                text = SetConfigValue(text, "gisUrl", gisUrlBox.Text.Trim());
                File.WriteAllText(path, text, new UTF8Encoding(false));
                AppendLog("Ссылки сохранены в config.js.");
                SetStatus("Ссылки сохранены");
                MessageBox.Show("Ссылки сохранены. Следующий запуск бота будет использовать эти адреса.", "Кадастробот", MessageBoxButtons.OK, MessageBoxIcon.Information);
            }
            catch (Exception ex)
            {
                MessageBox.Show("Не удалось сохранить ссылки:\n" + ex.Message, "Ошибка сохранения", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        private string SetConfigValue(string text, string key, string value)
        {
            var pattern = Regex.Escape(key) + @"\s*:\s*(['""])(.*?)\1";
            var replacement = key + ": '" + EscapeJs(value) + "'";
            if (Regex.IsMatch(text, pattern, RegexOptions.Singleline))
            {
                return Regex.Replace(text, pattern, match => replacement, RegexOptions.Singleline);
            }

            var insertAt = text.LastIndexOf("};", StringComparison.Ordinal);
            if (insertAt >= 0)
            {
                var prefix = text.Substring(0, insertAt).TrimEnd();
                var suffix = text.Substring(insertAt);
                return prefix + "," + Environment.NewLine + "  " + replacement + Environment.NewLine + suffix;
            }
            return text + Environment.NewLine + "module.exports." + key + " = '" + EscapeJs(value) + "';" + Environment.NewLine;
        }

        private string EscapeJs(string value)
        {
            return (value ?? "").Replace("\\", "\\\\").Replace("'", "\\'");
        }

        private string UnescapeJs(string value)
        {
            return (value ?? "").Replace("\\'", "'").Replace("\\\\", "\\");
        }

        private void StartChrome()
        {
            if (!File.Exists(ChromePath))
            {
                MessageBox.Show("Chrome не найден по пути:\n" + ChromePath + "\n\nУстановите Google Chrome или запустите его вручную с портом 9222.", "Chrome не найден", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }
            Process.Start(new ProcessStartInfo
            {
                FileName = ChromePath,
                Arguments = ChromeArgs,
                UseShellExecute = true
            });
            AppendLog("Chrome запущен с портом 9222.");
            SetStatus("Chrome 9222 запущен");
        }

        private void OpenRequiredTabs()
        {
            StartChrome();
            var urls = new[] { sheetsUrlBox.Text.Trim(), nspdUrlBox.Text.Trim(), rosreestrUrlBox.Text.Trim(), gisUrlBox.Text.Trim() };
            foreach (var url in urls)
            {
                if (string.IsNullOrWhiteSpace(url)) continue;
                try
                {
                    Process.Start(new ProcessStartInfo
                    {
                        FileName = ChromePath,
                        Arguments = ChromeArgs + " " + Quote(url),
                        UseShellExecute = true
                    });
                    AppendLog("Открываю вкладку: " + url);
                }
                catch (Exception ex)
                {
                    AppendLog("Не удалось открыть вкладку: " + ex.Message);
                }
            }
            SetStatus("Вкладки открыты");
        }

        private void StopRunningProcess()
        {
            try
            {
                if (runningProcess != null && !runningProcess.HasExited)
                {
                    runningProcess.Kill();
                    AppendLog("Процесс остановлен.");
                }
            }
            catch (Exception ex)
            {
                AppendLog("Не удалось остановить процесс: " + ex.Message);
            }
            finally
            {
                runningProcess = null;
                SetRunningUi(false);
                SetStatus("Остановлено");
                if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
                Activate();
            }
        }

        private void RunBot(string mode)
        {
            if (runningProcess != null && !runningProcess.HasExited)
            {
                MessageBox.Show("Бот уже работает. Сначала нажмите Стоп или дождитесь завершения.", "Уже работает", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }

            var startRow = startRowBox.Text.Trim();
            if (string.IsNullOrWhiteSpace(startRow)) startRow = "2";
            int parsedStart;
            if (!int.TryParse(startRow, out parsedStart) || parsedStart < 2)
            {
                MessageBox.Show("Стартовая строка должна быть числом от 2.", "Неверная строка", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }

            var args = new StringBuilder();
            args.Append("start.js ");
            args.Append(parsedStart);
            if (mode == "nspd") args.Append(" --nspd-only");
            if (mode == "nspd-common") args.Append(" --nspd-common-nonres");
            if (refreshNspdBox.Checked && (mode == "full" || mode == "nspd" || mode == "nspd-common")) args.Append(" --refresh-nspd");
            if (mode == "rr") args.Append(" --ros-only");
            if (mode == "rr-nonres") args.Append(" --ros-nonres-only");
            if (mode == "rr-ranges")
            {
                var ranges = rangesBox.Text.Trim();
                if (string.IsNullOrWhiteSpace(ranges))
                {
                    MessageBox.Show("Введите диапазон строк, например: 2-122, 123-127", "Нужен диапазон", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                    return;
                }
                args.Append(" --ros-ranges ");
                args.Append(Quote(ranges));
            }

            var startJs = Path.Combine(BaseDir(), "start.js");
            if (!File.Exists(startJs))
            {
                MessageBox.Show("Не найден start.js рядом с приложением:\n" + startJs, "Файл не найден", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return;
            }

            var nodePath = BundledNodePath();
            if (!File.Exists(nodePath))
            {
                MessageBox.Show("Не найден встроенный Node runtime:\n" + nodePath + "\n\nПереустановите приложение.", "Файл не найден", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return;
            }

            try
            {
                var logDir = Path.Combine(BaseDir(), "logs");
                Directory.CreateDirectory(logDir);
                sessionLogPath = Path.Combine(logDir, "run-" + DateTime.Now.ToString("yyyyMMdd-HHmmss") + ".log");
            }
            catch { sessionLogPath = null; }
            AppendLog("");
            AppendLog("=== Запуск: встроенный Node " + args + " ===");
            SetStatus("Работает...");
            SetRunningUi(true);

            var psi = new ProcessStartInfo
            {
                FileName = nodePath,
                Arguments = args.ToString(),
                WorkingDirectory = BaseDir(),
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true,
                StandardOutputEncoding = Encoding.UTF8,
                StandardErrorEncoding = Encoding.UTF8
            };

            try
            {
                var process = new Process { StartInfo = psi, EnableRaisingEvents = true };
                runningProcess = process;
                process.OutputDataReceived += (sender, e) => { if (e.Data != null) AppendLog(e.Data); };
                process.ErrorDataReceived += (sender, e) => { if (e.Data != null) AppendLog(e.Data); };
                process.Exited += (sender, e) =>
                {
                    var code = process.ExitCode;
                    if (runningProcess == process) runningProcess = null;
                    SetRunningUi(false);
                    SetStatus(code == 0 ? "Готово" : "Завершено с ошибкой");
                    AppendLog("=== Процесс завершен, код " + code + " ===");
                };
                process.Start();
                process.BeginOutputReadLine();
                process.BeginErrorReadLine();
            }
            catch (Exception ex)
            {
                runningProcess = null;
                SetRunningUi(false);
                SetStatus("Ошибка запуска");
                AppendLog("Ошибка запуска: " + ex.Message);
                MessageBox.Show("Не удалось запустить встроенный runtime.\n\nПереустановите приложение.", "Ошибка запуска", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        private string Quote(string value)
        {
            return "\"" + value.Replace("\"", "\\\"") + "\"";
        }

        private string BuildHelpText()
        {
            return
@"Кадастробот: инструкция
=======================

БЫСТРЫЙ СТАРТ

1. Нажмите «Открыть Chrome».
2. В открытом Chrome войдите в Google, Росреестр и ГИС ЖКХ.
3. Нажмите «Открыть сервисы».
4. Проверьте, что в Google Sheets в N2 указан кадастровый номер МКД.
5. Укажите стартовую строку. Обычно это 2.
6. Выберите нужный режим запуска.

Флажок «Обновить НСПД без кэша» обычно оставляйте выключенным.
Включайте его только для принудительного перечитывания всех карточек.

Node.js отдельно устанавливать не нужно. Он уже встроен в приложение.


РЕЖИМЫ РАБОТЫ

1. Открыть Chrome
   Открывает правильный Chrome с портом для управления ботом.

2. Открыть сервисы
   Открывает Google Sheets, НСПД, Росреестр и ГИС ЖКХ.
   Ссылки можно изменить во вкладке «Источники».

3. Начать полный сбор
   НСПД быстро получает карточку дома и список его объектов. Кадастры
   из другого квартала отбрасываются до запросов в Росреестр.
   Росреестр через быстрый JSON-запрос заполняет:
   - C:F и H: параметры объекта;
   - I:L: сведения о правах;
   - M2: год постройки;
   - O2: площадь ПКК.

   После Росреестра НСПД подробно проверяет только нежилые помещения
   и записывает признак общего имущества в G. Жилые карточки НСПД
   по одной не запрашиваются, поэтому полный сбор стал значительно быстрее.

   ГИС ЖКХ заполняет:
   - Q2: сумма площади жилых помещений и нежилых помещений
     без помещений общего пользования.

4. Данные НСПД
   Заполняет только данные НСПД: A:H, M2 и O2.
   Колонки Росреестра I:L не стираются.
   Это полный повторный сбор карточек всех объектов, поэтому на больших
   домах он остается самым долгим режимом.

5. Росреестр: все объекты
   Берет кадастр МКД из N2, заполняет P2 и Q2,
   затем идет по строкам начиная со стартовой строки.

6. Росреестр: нежилые
   Одним чтением получает B:C, заранее формирует список строк со значением
   «Нежилое» и только после фильтрации отправляет этот список в РР.
   P2 и Q2 не обновляются, чтобы режим работал быстрее.

7. Проверить строки
   Проверяет права только в заданных строках.
   Примеры:
   - 2-122
   - 2-122, 123-127
   - 5, 9, 12-20

8. Общее имущество
   Одним чтением получает текущие B:C, заранее формирует список нежилых,
   обращается к НСПД только по этому списку и пачками обновляет G.
   Используйте этот режим, если A:F и H уже заполнены.


КОЛОНКИ В ТАБЛИЦЕ

A  Номер по порядку
B  Кадастровый номер помещения или машиноместа
C  Назначение
D  Этаж
E  Площадь
F  Форма собственности
G  Общее имущество
H  Полный адрес объекта
I  Тип собственности
J  Дата права
K  Номер права
L  Статус
M2 Год постройки
N2 Кадастр МКД
O2 Площадь ПКК
P2 Площадь РР
Q2 Площадь ГИС ЖКХ


НАСТРОЙКА ССЫЛОК

Во вкладке «Источники» можно заменить ссылку на Google-таблицу
или адреса сервисов без дополнительного пароля.
После изменения нажмите «Сохранить ссылки».
Настроенные ссылки сохраняются при обновлении программы.


ПРАВИЛЬНЫЙ CHROME

Команда, которую запускает приложение:

""C:\Program Files\Google\Chrome\Application\chrome.exe"" --remote-debugging-port=9222 --user-data-dir=""C:\chrome-remote"" --profile-directory=Default

Если бот не подключается:
1. Закройте все окна специального Chrome.
2. Нажмите «Открыть Chrome» снова.
3. Нажмите «Открыть сервисы».
4. Авторизуйтесь в сервисах.
5. Запустите нужный режим.

ОБНОВЛЕНИЯ

- При запуске Кадастробот сам проверяет последний релиз на GitHub.
- Если найдена новая версия, сверху появляется кнопка «Обновить до ...».
- По кнопке установщик скачивается и запускается автоматически.
- Во время активного сбора обновление заблокировано, чтобы не потерять прогресс.


ПРОГРЕСС И ВОЗОБНОВЛЕНИЕ

- Прогресс отображается под кнопкой «Остановить».
- Подробный лог сохраняется в папке logs рядом с программой.
- Незавершённый быстрый запуск автоматически продолжится с последней
  сохранённой контрольной точки для того же дома и стартовой строки.
- Техническая ошибка Росреестра не превращается в «Отсутствует».
- Если авторизация Росреестра истекла, бот остановится перед проверкой прав,
  попросит войти через ЕСИА и продолжит с той же строки после перезапуска.
- Список дома и проверенные карточки нежилых кэшируются на 24 часа.

Если приложение сообщает, что не найден runtime:
переустановите Кадастробот из установщика.";
        }

        [STAThread]
        public static void Main()
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new LauncherForm());
        }
    }
}
