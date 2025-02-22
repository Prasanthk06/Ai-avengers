let currentCategory = null;  // Add this at the top
let currentSort = 'new'; // Default sort by newest first

document.addEventListener('DOMContentLoaded', () => {
    loadCategories();
    loadFiles();

    // Category click handler
    document.getElementById('categoryMenu').addEventListener('click', (e) => {
        if (e.target.tagName === 'LI') {
            currentCategory = e.target.dataset.category;  // Update currentCategory
            loadFiles(currentCategory, '', currentSort);
            
            // Update active state
            document.querySelectorAll('.menu li').forEach(li => {
                li.classList.remove('active');
            });
            e.target.classList.add('active');
        }
    });

    // Search functionality
    const searchInput = document.querySelector('.search');
    searchInput.addEventListener('input', debounce(() => {
        loadFiles(currentCategory, searchInput.value, currentSort);
    }, 300));

    // Sorting functionality
    document.getElementById('sortBtn').addEventListener('click', () => {
        const sortDropdown = document.getElementById('sortDropdown');
        sortDropdown.classList.toggle('active');
    });

    document.querySelectorAll('.sort-option').forEach(option => {
        option.addEventListener('click', () => {
            currentSort = option.dataset.sort;
            document.getElementById('sortBtn').textContent = `Sort: ${currentSort === 'new' ? 'Newest First ↓' : 'Oldest First ↑'}`;
            document.getElementById('sortDropdown').classList.remove('active');
            loadFiles(currentCategory, searchInput.value, currentSort);
        });
    });

    // Close dropdown when clicking outside
    document.addEventListener('click', (e) => {
        if (!e.target.closest('.sort-container')) {
            document.getElementById('sortDropdown').classList.remove('active');
        }
    });
});

async function loadFiles(category = null, search = '', sort = 'new') {
    console.log('Loading files...');
    const response = await fetch(`/user-files?category=${category || ''}&search=${search}&sort=${sort}`);
    const files = await response.json();
    console.log('Files received:', files);
    
    const fileGrid = document.querySelector('.file-grid');
    fileGrid.innerHTML = files.map(file => `
        <div class="file" onclick="showFileOptions('${file.mediaUrl}', '${file.type}')">
            <div class="thumbnail ${getFileType(file.type)}" style="background-image: url('${file.mediaUrl}'); background-size: cover; background-position: center;"></div>
            <p>${file.metadata.subject || file.mediaUrl.split('/').pop()}</p>
        </div>
    `).join('');
}

function showFileOptions(url, type) {
    const modal = document.createElement('div');
    modal.className = 'file-modal';
    modal.innerHTML = `
        <div class="modal-content">
            <div class="preview-area">
                ${type.includes('image') ? `<img src="${url}" alt="preview">` : 
                  type.includes('pdf') ? `<iframe src="${url}"></iframe>` : ''}
            </div>
            <div class="modal-buttons">
                <button onclick="window.open('${url}', '_blank')">Preview</button>
                <a href="${url}" download>Download</a>
            </div>
            <span class="close-modal">×</span>
        </div>
    `;
    document.body.appendChild(modal);
    
    modal.querySelector('.close-modal').onclick = () => modal.remove();
}

function getFileType(mimeType) {
    if (mimeType.includes('video')) return 'video';
    if (mimeType.includes('image')) return 'image';
    if (mimeType.includes('pdf')) return 'pdf';
    return '';
}

// Utility function for search debouncing
function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}

const logoutBtn = document.getElementById('logoutBtn');
logoutBtn.addEventListener('click', () => {
    fetch('/logout', {
        method: 'GET',
        headers: {
            'Content-Type': 'application/json'
        }
    }).then(response => {
        if (response.ok) {
            window.location.href = '/logout';
        } else {
            alert('Logout failed');
        }
    });
});